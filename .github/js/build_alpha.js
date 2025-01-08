const core = require('@actions/core');
const github = require('@actions/github');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const execSync = require('child_process').execSync;

// Получение переменных окружения
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GOOGLE_SERVICE_ACCOUNT_KEY = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;

// Инициализация клиентов Гитхаба и Гугл-таблиц
const octokit = github.getOctokit(GITHUB_TOKEN);

const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(GOOGLE_SERVICE_ACCOUNT_KEY),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const sheets = google.sheets({ version: 'v4', auth });

// Основная функция
(async () => {
    try {
        console.log('Текущий рабочий каталог:', process.cwd());
        console.log('Содержание корневого каталога:', fs.readdirSync('.'));
        console.log('Содержание каталога «Набор ресурсов»:', fs.readdirSync('Набор ресурсов'));

        // 1. Получение списка всех тегов.
        const tags = await octokit.paginate(octokit.rest.repos.listTags, {
            ...github.context.repo,
            per_page: 100,
        });

        console.log(`Всего тегов получено: ${tags.length}`);

        // 2. Нахождение последнего тега (альфа или бета).
        const lastTag = getLastVersionTag(tags);

        console.log(`Последний тег: ${lastTag}`);

        // 3. Определение следующего тега.
        const nextTagInfo = getNextAlphaTag(lastTag);

        console.log(`Следующий тег: ${nextTagInfo.tag}`);

        // 4. Получение списка изменённых файлов.
        const changedFiles = getChangedFiles(lastTag);

        console.log(`Изменённые файлы:\n${changedFiles.map(f => `${f.status}\t${f.filePath}`).join('\n')}`);

        // 5. Обработка изменений и формирование описания выпуска.
        const releaseNotes = await generateReleaseNotes(changedFiles, sheets, nextTagInfo, lastTag);

        console.log(`Описание выпуска:\n${releaseNotes}`);

        // 6. Получение версий архивов из предыдущего выпуска.
        const previousAssetVersions = await getPreviousAssetVersions(lastTag);

        // 7. Создание архивов.
        const assets = createArchives(changedFiles, nextTagInfo, previousAssetVersions, lastTag);

        // 8. Создание выпуска на Гитхабе.
        await createRelease(nextTagInfo, releaseNotes, assets);

        console.log('Выпуск успешно создан.');
    } catch (error) {
        core.setFailed(error.message);
    }
})();

// Функция для получения последнего тега (альфа или бета)

function getLastVersionTag(tags) {
    const versionTags = tags.filter(tag =>
        /^(?:dev\d+|\d+(?:\.0)?-C\d+-B\d+(?:-A\d+)?)$/.test(tag.name)
    );
    if (versionTags.length === 0) return null;

    // Сортировка тегов по версии
    versionTags.sort((a, b) => {
        const versionA = getVersionNumber(a.name);
        const versionB = getVersionNumber(b.name);
        return versionB - versionA;
    });
    return versionTags[0].name;
}

// Функция для получения числового значения тега (для сортировки)

function getVersionNumber(tag) {
    const devMatch = tag.match(/^dev(\d+)$/);
    if (devMatch) return parseInt(devMatch[1]);

    const tagMatch = tag.match(/^(\d+)(?:\.(\d+))?-C(\d+)-B(\d+)(?:-A(\d+))?$/);
    if (tagMatch) {
        const releaseNumMain = parseInt(tagMatch[1]);
        const releaseNumMinor = tagMatch[2] ? parseInt(tagMatch[2]) : 0;
        const candidateNum = parseInt(tagMatch[3]);
        const betaNum = parseInt(tagMatch[4]);
        const alphaNum = tagMatch[5] ? parseInt(tagMatch[5]) : 0;

        // Считаем общий номер версии для сортировки
        // Приоритет: releaseNumMain → releaseNumMinor → candidateNum → betaNum → alphaNum
        return (
            releaseNumMain * 100000000 +
            releaseNumMinor * 1000000 +
            candidateNum * 10000 +
            betaNum * 100 +
            alphaNum
        );
    }

    return 0;
}

// Функция для определения следующего тега

function getNextAlphaTag(lastTag) {
    let releaseNumMain = 1;
    let releaseNumMinor = 0;
    let candidateNum = 1;
    let betaNum = 1;
    let alphaNum = 1;

    if (lastTag) {
        const devMatch = lastTag.match(/^dev(\d+)$/);
        const tagMatch = lastTag.match(/^(\d+)(?:\.(\d+))?-C(\d+)-B(\d+)(?:-A(\d+))?$/);

        if (devMatch) {
            // Если предыдущий тег dev, просто увеличиваем alphaNum
            alphaNum = parseInt(devMatch[1]) + 1;
        } else if (tagMatch) {
            releaseNumMain = parseInt(tagMatch[1]);
            releaseNumMinor = tagMatch[2] ? parseInt(tagMatch[2]) : 0;
            candidateNum = parseInt(tagMatch[3]);
            betaNum = parseInt(tagMatch[4]);

            if (tagMatch[5]) {
                // Если последний тег был альфа-версией, увеличиваем номер альфы
                alphaNum = parseInt(tagMatch[5]) + 1;
            } else {
                // Если последний тег был бета-версией, увеличиваем номер беты и сбрасываем номер альфы
                betaNum += 1;
                alphaNum = 1;
            }
        }
    }

    // Формируем новую строку: 1.0-C1-B1-A1
    let releaseNumPart = `${releaseNumMain}.${releaseNumMinor}`;
    const newTag = `${releaseNumPart}-C${candidateNum}-B${betaNum}-A${alphaNum}`;
    const title = `${alphaNum}-я альфа`;

    return {
        tag: newTag,
        title,
        releaseNumMain,
        releaseNumMinor,
        candidateNum,
        betaNum,
        alphaNum,
    };
}

// Функция для получения списка изменённых файлов

function getChangedFiles(lastTag) {
    let diffCommand = 'git -c core.quotepath=false -c i18n.logOutputEncoding=UTF-8 diff --name-status';
    if (lastTag) {
        diffCommand += ` ${lastTag} HEAD`;
    } else {
        // Если нет предыдущего тега, получаем изменения в последнем коммите
        diffCommand += ' HEAD~1 HEAD';
    }

    const diffOutput = execSync(diffCommand, { encoding: 'utf8' });
    const changedFiles = diffOutput
        .trim()
        .split('\n')
        .map(line => {
            const [status, ...fileParts] = line.split('\t');
            const filePath = fileParts.join('\t');
            return { status, filePath };
    });

    return changedFiles;
}

// Функция для получения информации о моде из таблицы

async function getModInfoFromSheet(modId, gameVer, sheets) {
    const spreadsheetId = '1kGGT2GGdG_Ed13gQfn01tDq2MZlVOC9AoiD1s3SDlZE';
    const range = 'db!A1:Z1000';

    const response = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range,
    });

    const rows = response.data.values;
    if (!rows || rows.length === 0) return null;

    const headers = rows[0];
    const idIndex = headers.indexOf('id');
    const gameVerIndex = headers.indexOf('gameVer');
    const nameIndex = headers.indexOf('name');
    const modrinthUrlIndex = headers.indexOf('modrinthUrl');
    const cfUrlIndex = headers.indexOf('cfUrl');
    const fallbackUrlIndex = headers.indexOf('fallbackUrl');
    const popularityIndex = headers.indexOf('popularity');

    // Приведение идентификатора и версии игры мода в надлежащий вид
    const normalizedModId = modId.trim().toLowerCase();
    const normalizedGameVer = gameVer.trim().toLowerCase();

    // Сборка всех строк, совпадающих с идентификатором или названием, игнорируя регистр
    const possibleMatches = [];
    for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        if (!row || (!(row[idIndex] || row[nameIndex]))) {
            continue; // Пропуск пустых строк
        }

        const rowIdRaw = row[idIndex] ? row[idIndex].trim().toLowerCase() : '';
        const rowNameRaw = row[nameIndex] ? row[nameIndex].trim().toLowerCase() : '';
        const rowGameVerRaw = row[gameVerIndex] ? row[gameVerIndex].trim().toLowerCase() : '';

        // 1) если у строки есть идентификатор, проверить совпадает ли он с идентификатором мода,
        // 2) если у строки нет идентификатора, проверить, включает ли название мода идентификатор мода (как резервный вариант)
        //    (или проверить, равно ли rowNameRaw normalizedModId, чтобы получить точное совпадение).
        const idMatches = rowIdRaw && (rowIdRaw === normalizedModId);
        const nameMatches =
            (!rowIdRaw && rowNameRaw.includes(normalizedModId)) ||
            rowNameRaw === normalizedModId;

        if (idMatches || nameMatches) {
            possibleMatches.push({ row, rowGameVerRaw });
        }
    }

    // Если совпадений нет, вернуть null
    if (possibleMatches.length === 0) return null;

    // Попытка найти строку, чья версия игры начинается с заданной версии
    // Если не нашлась, просто взять первое совпадение
    let bestRowEntry = possibleMatches.find(entry =>
        entry.rowGameVerRaw && entry.rowGameVerRaw.startsWith(normalizedGameVer)
    );
    if (!bestRowEntry) {
        bestRowEntry = possibleMatches[0];
    }

    // Сборка возвращаемого объекта из выбранной строки
    const bestRow = bestRowEntry.row;
    const rowName = bestRow[nameIndex] || modId;
    const modrinthUrl = bestRow[modrinthUrlIndex] || '';
    const cfUrl = bestRow[cfUrlIndex] || '';
    const fallbackUrl = bestRow[fallbackUrlIndex] || '';
    const url = modrinthUrl || cfUrl || fallbackUrl;
    const popularity = popularityIndex !== -1 && bestRow[popularityIndex]
        ? parseInt(bestRow[popularityIndex])
        : 0;

    return {
        name: rowName,
        url,
        popularity,
    };
}

// Функция для получения информации об изменениях модов

async function getModChanges(changedFiles, sheets) {
    const modChanges = [];
    const newGameVersions = [];

    for (const file of changedFiles) {
        const decodedFilePath = file.filePath;

        // Проверка на добавление pack.mcmeta (новая поддерживаемая версия)
        const packMcmetaMatch = decodedFilePath.match(/^Набор ресурсов\/([^/]+)\/pack\.mcmeta$/);
        if (packMcmetaMatch && file.status.startsWith('A')) {
            const gameVer = packMcmetaMatch[1];
            newGameVersions.push(gameVer);
            continue;
        }

        // Проверка на языковые файлы модов
        if (/^Набор ресурсов\/[^/]+\/assets\/[^/]+\/lang\/ru_(RU|ru)\.(json|lang)$/.test(decodedFilePath)) {
            const parts = decodedFilePath.split('/');
            const gameVer = parts[1];
            const modId = parts[3];
            const action = file.status.startsWith('A') ? 'добавлен' : 'изменён';

            const modInfo = await getModInfoFromSheet(modId, gameVer, sheets);
            if (modInfo) {
                modChanges.push({
                    action,
                    name: modInfo.name,
                    url: modInfo.url,
                    gameVer,
                    popularity: modInfo.popularity,
                });
            }
        }
    }

    const uniqueGameVersions = [...new Set(newGameVersions)];
    return {
        modChanges,
        newGameVersions: uniqueGameVersions,
    };
}

// Функция для генерации описания выпуска
// Группирует изменения по модам, чтобы список был компактнее, и сортирует по popularity (большее число — выше)

async function generateReleaseNotes(changedFiles, sheets, nextTagInfo, lastTag) {
    let description = `Это ${nextTagInfo.alphaNum}-я альфа-версия всех переводов проекта.\n\n`;

    if (lastTag && /^dev\d+$/.test(lastTag)) {
        description += `Пререлизы были упразднены! Теперь пререлизы зовутся альфами. Про то, как теперь выходят ранние версии проекта, можете прочитать [здесь](https://github.com/RushanM/Minecraft-Mods-Russian-Translation/blob/beta/%D0%A0%D1%83%D0%BA%D0%BE%D0%B2%D0%BE%D0%B4%D1%81%D1%82%D0%B2%D0%BE/%D0%98%D0%BC%D0%B5%D0%BD%D0%BE%D0%B2%D0%B0%D0%BD%D0%B8%D0%B5%20%D0%B2%D1%8B%D0%BF%D1%83%D1%81%D0%BA%D0%BE%D0%B2.md).\n\n`;
    } else {
        // Стандартный текст
        description += `Про то, как выходят ранние версии проекта, можете прочитать [здесь](https://github.com/RushanM/Minecraft-Mods-Russian-Translation/blob/beta/%D0%A0%D1%83%D0%BA%D0%BE%D0%B2%D0%BE%D0%B4%D1%81%D1%82%D0%B2%D0%BE/%D0%98%D0%BC%D0%B5%D0%BD%D0%BE%D0%B2%D0%B0%D0%BD%D0%B8%D0%B5%20%D0%B2%D1%8B%D0%BF%D1%83%D1%81%D0%BA%D0%BE%D0%B2.md).\n\n`;
    }

    // Получение изменений модов и новых версий
    const { modChanges, newGameVersions } = await getModChanges(changedFiles, sheets);
    const allChanges = [];

    // Добавление информации о новых версиях Minecraft (pack.mcmeta добавлен)
    newGameVersions.forEach(gameVer => {
        // Если версия — b1.7.3, не добавляем суффикс .x
        if (gameVer === 'b1.7.3') {
            allChanges.push(`начат перевод модов для Minecraft ${gameVer}`);
        } else {
            allChanges.push(`начат перевод модов для Minecraft ${gameVer}.x`);
        }
    });

    // Группировка изменений модов
    const grouped = {};
    modChanges.forEach(change => {
        // Ключ для группировки
        const key = `${change.action}::${change.name}::${change.url}::${change.popularity}`;
        if (!grouped[key]) {
            grouped[key] = [];
        }
        grouped[key].push(change.gameVer);
    });

    // Преобразование группы в список (для сортировки и вывода)
    let groupedList = Object.keys(grouped).map(key => {
        const [action, name, url, popularity] = key.split('::');
        const versions = grouped[key].map(ver => {
            const num = parseFloat(ver) || 0;
            return { original: ver, numeric: num };
        });
        return {
            action,
            name,
            url,
            popularity: parseInt(popularity),
            versions,
        };
    });

    // Сортируем по popularity, затем по названию
    groupedList.sort((a, b) => {
        if (b.popularity !== a.popularity) {
            return b.popularity - a.popularity;
        }
        // Если популярность одинаковая, то по названию
        return a.name.localeCompare(b.name);
    });

    // Формируем строки описаний для каждой группы
    for (const group of groupedList) {
        const { action, name, url, versions } = group;
        versions.sort((a, b) => a.numeric - b.numeric);

        if (versions.length === 1) {
            // Если одна версия
            const versionLabel = versions[0].original === 'b1.7.3'
                ? versions[0].original
                : `${versions[0].original}.x`;
            allChanges.push(`${action} перевод мода [${name}](${url}) на Minecraft ${versionLabel}`);
        } else {
            // Несколько версий
            const start = versions[0].original;
            const end = versions[versions.length - 1].original;
            if (start === end) {
                // Одинаковая версия
                const versionLabel = start === 'b1.7.3' ? start : `${start}.x`;
                allChanges.push(`${action} перевод мода [${name}](${url}) на Minecraft ${versionLabel}`);
            } else {
                // Диапазон версий
                const startLabel = start === 'b1.7.3' ? start : `${start}.x`;
                const endLabel = end === 'b1.7.3' ? end : `${end}.x`;
                allChanges.push(`${action} перевод мода [${name}](${url}) на Minecraft ${startLabel} — ${endLabel}`);
            }
        }
    }

    // Формирование итогового описания изменений
    if (allChanges.length === 1) {
        const singleChange = allChanges[0].charAt(0).toUpperCase() + allChanges[0].slice(1);
        description += singleChange;
    } else if (allChanges.length > 1) {
        description += `Изменения в этой версии:\n\n`;
        // Перечисляем через «* »
        allChanges.forEach((entry, index) => {
            const isLast = index === allChanges.length - 1;
            description += isLast ? `* ${entry}.\n` : `* ${entry},\n`;
        });
    }

    return description.trim();
}

// Функция для получения версий архивов из предыдущего выпуска

async function getPreviousAssetVersions(lastTag) {
    if (!lastTag) {
        return {};
    }
    const releases = await octokit.paginate(octokit.rest.repos.listReleases, {
        ...github.context.repo,
        per_page: 100,
    });
    const lastRelease = releases.find(release => release.tag_name === lastTag);
    const versions = {};

    if (lastRelease && lastRelease.assets && lastRelease.assets.length > 0) {
        lastRelease.assets.forEach(asset => {
            const match = asset.name.match(/^(.*?)-((?:dev\d+|\d+(?:\.\d+)?-C\d+-B\d+-A\d+))\.zip$/);
            if (match) {
                const baseName = match[1];
                const version = match[2];
                versions[baseName] = version;
            }
        });
    }
    console.log('Предыдущие версии архивов:', versions);
    return versions;
}

// Функция для создания архивов с учётом версий файлов

function createArchives(changedFiles, nextTagInfo, previousAssetVersions, lastTag) {
    const assets = [];
    const releasesDir = path.join(process.cwd(), 'releases');
    if (!fs.existsSync(releasesDir)) {
        fs.mkdirSync(releasesDir, { recursive: true });
    }

    // Создание архивов для набора ресурсов
    const resourcePackDir = 'Набор ресурсов';
    if (fs.existsSync(resourcePackDir)) {
        const resourcePackVersions = fs
            .readdirSync(resourcePackDir)
            .filter(ver => fs.statSync(path.join(resourcePackDir, ver)).isDirectory());

        resourcePackVersions.forEach(ver => {
            const baseName = `Rus-For-Mods-${ver}`;
            let prevVersion = previousAssetVersions[baseName];
            const versionDir = path.join(resourcePackDir, ver);
            const relatedFiles = changedFiles.filter(file => file.filePath.startsWith(versionDir));

            let assetVersion;
            if (prevVersion) {
                const prevVersionNumber = getAssetVersionNumber(prevVersion);
                if (relatedFiles.length > 0) {
                    assetVersion = incrementAssetVersion(prevVersionNumber);
                } else {
                    assetVersion = prevVersionNumber;
                }
            } else {
                // Если нет предыдущей версии, начинаем с 1.0-C1-B1-AX (или devX)
                if (lastTag && lastTag.startsWith('dev')) {
                    const devNumber = parseInt(lastTag.slice(3));
                    assetVersion = `1.0-C1-B1-A${devNumber}`;
                } else {
                    assetVersion = nextTagInfo.tag;
                }
            }

            const archiveName = `${baseName}-${assetVersion}.zip`;
            const outputPath = path.join(releasesDir, archiveName);
            const zip = new AdmZip();

            // Добавление в ZIP
            const assetsPath = path.join(versionDir, 'assets');
            if (fs.existsSync(assetsPath)) {
                zip.addLocalFolder(assetsPath, 'assets');
            }

            // Добавление файлов из папки версии
            ['pack.mcmeta', 'dynamicmcpack.json', 'respackopts.json5'].forEach(fileName => {
                const filePath = path.join(versionDir, fileName);
                if (fs.existsSync(filePath)) {
                    zip.addLocalFile(filePath, '', fileName);
                }
            });

            // Общие файлы
            if (fs.existsSync('Набор ресурсов/pack.png')) {
                zip.addLocalFile('Набор ресурсов/pack.png');
            }
            if (fs.existsSync('Набор ресурсов/peruse_or_bruise.txt')) {
                zip.addLocalFile('Набор ресурсов/peruse_or_bruise.txt');
            }

            zip.writeZip(outputPath);
            console.log(`Создан архив: ${outputPath}`);

            assets.push({
                path: outputPath,
                name: archiveName,
            });
        });
    }

    // Аналогичная логика для «Наборы шейдеров»
    const shaderPacksDir = 'Наборы шейдеров';
    if (fs.existsSync(shaderPacksDir)) {
        const shaderPacks = fs
            .readdirSync(shaderPacksDir)
            .filter(pack => fs.statSync(path.join(shaderPacksDir, pack)).isDirectory());

        shaderPacks.forEach(pack => {
            const baseName = `${pack.replace(/\s+/g, '-')}-Russian-Translation`;
            let prevVersion = previousAssetVersions[baseName];

            // Проверка, изменились ли файлы в этом наборе шейдеров
            const packDir = path.join(shaderPacksDir, pack);
            const relatedFiles = changedFiles.filter(file => file.filePath.startsWith(packDir));

            let assetVersion;
            if (prevVersion) {
                // Извлечение номера предыдущей версии
                const prevVersionNumber = getAssetVersionNumber(prevVersion);

                if (relatedFiles.length > 0) {
                    // Увеличение версии
                    assetVersion = incrementAssetVersion(prevVersionNumber);
                } else {
                    // Оставляем версию прежней
                    assetVersion = prevVersionNumber;
                }
            } else {
                // Если нет предыдущей версии, начинаем с 1-й альфы или используем версию из dev
                if (lastTag && lastTag.startsWith('dev')) {
                    const devNumber = parseInt(lastTag.slice(3));
                    assetVersion = `1.0-C1-B1-A${devNumber}`;
                } else {
                    assetVersion = nextTagInfo.tag;
                }
            }

            const archiveName = `${baseName}-${assetVersion}.zip`;
            const outputPath = path.join(releasesDir, archiveName);

            const zip = new AdmZip();
            zip.addLocalFolder(packDir);
            zip.writeZip(outputPath);

            console.log(`Создан архив: ${outputPath}`);

            assets.push({
                path: outputPath,
                name: archiveName,
            });
        });
    }

    // Аналогичная логика для «Сборки»
    const modpacksDir = 'Сборки';
    if (fs.existsSync(modpacksDir)) {
        const modpacks = fs
            .readdirSync(modpacksDir)
            .filter(modpack => {
                const translationPath = path.join(modpacksDir, modpack, 'Перевод');
                return fs.existsSync(translationPath) && fs.statSync(translationPath).isDirectory();
            });

        modpacks.forEach(modpack => {
            const baseName = `${modpack.replace(/\s+/g, '-')}-Russian-Translation`;
            let prevVersion = previousAssetVersions[baseName];

            // Проверка, изменились ли файлы в этой сборке
            const packDir = path.join(modpacksDir, modpack, 'Перевод');
            const relatedFiles = changedFiles.filter(file => file.filePath.startsWith(packDir));

            let assetVersion;
            if (prevVersion) {
                // Извлечение номера предыдущей версии
                const prevVersionNumber = getAssetVersionNumber(prevVersion);

                if (relatedFiles.length > 0) {
                    // Увеличение версии
                    assetVersion = incrementAssetVersion(prevVersionNumber);
                } else {
                    // Оставляем версию прежней
                    assetVersion = prevVersionNumber;
                }
            } else {
                // Если нет предыдущей версии, начинаем с 1-й альфы или используем версию из dev
                if (lastTag && lastTag.startsWith('dev')) {
                    const devNumber = parseInt(lastTag.slice(3));
                    assetVersion = `1.0-C1-B1-A${devNumber}`;
                } else {
                    assetVersion = nextTagInfo.tag;
                }
            }

            const archiveName = `${baseName}-${assetVersion}.zip`;
            const outputPath = path.join(releasesDir, archiveName);

            const zip = new AdmZip();
            zip.addLocalFolder(packDir);
            zip.writeZip(outputPath);

            console.log(`Создан архив: ${outputPath}`);

            assets.push({
                path: outputPath,
                name: archiveName,
            });
        });
    }

    return assets;
}

// Функция для извлечения номера версии из названия архива

function getAssetVersionNumber(version) {
    // Если тег devNN
    if (version.startsWith('dev')) {
        return version.replace('dev', '1.0-C1-B1-A');
    }
    return version;
}

// Функция для увеличения версии

function incrementAssetVersion(version) {
    // Ищем паттерн: 1.0-C1-B1-A1
    const match = version.match(/^(\d+)(?:\.(\d+))?-C(\d+)-B(\d+)-A(\d+)$/);
    if (match) {
        const releaseNumMain = parseInt(match[1]);
        const releaseNumMinor = match[2] ? parseInt(match[2]) : 0;
        const candidateNum = parseInt(match[3]);
        const betaNum = parseInt(match[4]);
        const alphaNum = parseInt(match[5]) + 1;
        return `${releaseNumMain}.${releaseNumMinor}-C${candidateNum}-B${betaNum}-A${alphaNum}`;
    }
    return version; // Если формат не соответствует, возвращаем исходную версию
}

// Функция для создания выпуска на Гитхабе

async function createRelease(tagInfo, releaseNotes, assets) {
    const releaseResponse = await octokit.rest.repos.createRelease({
        ...github.context.repo,
        tag_name: tagInfo.tag,
        target_commitish: github.context.sha,
        name: tagInfo.title,
        body: releaseNotes,
        draft: false,
        prerelease: true,
    });

    const uploadUrl = releaseResponse.data.upload_url;
    for (const asset of assets) {
        const content = fs.readFileSync(asset.path);
        await octokit.rest.repos.uploadReleaseAsset({
            url: uploadUrl,
            headers: {
                'content-type': 'application/zip',
                'content-length': content.length,
            },
            name: asset.name,
            data: content,
        });
        console.log(`Загружен ассет: ${asset.name}`);
    }
}