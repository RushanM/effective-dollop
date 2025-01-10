// Скрипт для автоматического выпуска альфа-версий пачек переводов проекта по переводу модификаций Майнкрафта Дефлекты

//// Инициализация
////// Подключение пакетов, переменных среды, клиентов Гитхаба и Гугла
const core = require('@actions/core');
const github = require('@actions/github');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const execSync = require('child_process').execSync;

////// Загрузка переменных окружения GITHUB_TOKEN, GOOGLE_SERVICE_ACCOUNT_KEY
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GOOGLE_SERVICE_ACCOUNT_KEY = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;

////// Создание клиентов octokit (Гитхаба) и sheets (Гугл-таблиц)
const octokit = github.getOctokit(GITHUB_TOKEN);

const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(GOOGLE_SERVICE_ACCOUNT_KEY),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const sheets = google.sheets({ version: 'v4', auth });

//// Главная асинхронная функция
(async () => {
    try {
        ////////// Определение текущего рабочего каталога и вывод отладочной информации
        ////////// Вывод текущего каталога и списка файлов
        console.log('Текущий рабочий каталог:', process.cwd());
        console.log('Содержание корневого каталога:', fs.readdirSync('.'));
        console.log('Содержание каталога «Набор ресурсов»:', fs.readdirSync('Набор ресурсов'));

        ////////// Получение всех тегов репозитория (версий)
        const tags = await octokit.paginate(octokit.rest.repos.listTags, {
            ...github.context.repo,
            per_page: 100,
        });

        console.log(`Всего тегов получено: ${tags.length}`);

        ////////// Нахождение последнего тега (версии), соответствующей шаблонам devX или <числа>-C<число>-B<число>-A<число>
        const lastTag = getLastVersionTag(tags);

        console.log(`Последний тег: ${lastTag}`);

        ////////// Определение нового тега (следующей альфа-версии)
        const nextTagInfo = getNextAlphaTag(lastTag);

        console.log(`Следующий тег: ${nextTagInfo.tag}`);

        ////////// Получение информации о том, какие файлы изменились с момента последнего тега
        const changedFiles = getChangedFiles(lastTag);

        console.log(`Изменённые файлы:\n${changedFiles.map(f => `${f.status}\t${f.filePath}`).join('\n')}`);

        ////////// Генерация описания выпуска с использованием данных с таблицы на Гугл-таблицах
        const releaseNotes = await generateReleaseNotes(changedFiles, sheets, nextTagInfo, lastTag);

        console.log(`Описание выпуска:\n${releaseNotes}`);

        ////////// Получение версий архивов из предыдущего выпуска, если они есть
        const previousAssetVersions = await getPreviousAssetVersions(lastTag);

        ////////// Создание архивов (набора ресурсов, для наборов шейдеров, для сборок модов), учитывая изменённые файлы
        const assets = createArchives(changedFiles, nextTagInfo, previousAssetVersions, lastTag);

        ////////// Создание нового выпуска на Гитхабе с добавлением новосозданных архивов
        await createRelease(nextTagInfo, releaseNotes, assets);

        ////////// Вывод уведомления об успешном создании
        console.log('Выпуск успешно создан.');
        ////////// Завершение процесса с пометкой об ошибке в случае ошибки
    } catch (error) {
        core.setFailed(error.message);
    }
})();

////// Функция для получения последнего тега (альфа или бета)
function getLastVersionTag(tags) {
    //////// Фильтрация тегов по шаблонам
    const versionTags = tags.filter(tag =>
        /^(?:dev\d+|\d+(?:\.0)?-C\d+-B\d+(?:-A\d+)?)$/.test(tag.name)
    );
    if (versionTags.length === 0) return null;

    //////// Сортировка версий, вычисляя их числовое значение
    versionTags.sort((a, b) => {
        const versionA = getVersionNumber(a.name);
        const versionB = getVersionNumber(b.name);
        return versionB - versionA;
    });
    //////// Возвращение самого нового тега
    return versionTags[0].name;
}

////// Функция для получения числового значения тега для сортировки
function getVersionNumber(tag) {
    //////// Преобразование строки тега в числовое значение для сортировки
    //////// Учёт форматов devX и X(.Y)-CX-BX(-AX)

    const devMatch = tag.match(/^dev(\d+)$/);
    if (devMatch) return parseInt(devMatch[1]);

    const tagMatch = tag.match(/^(\d+)(?:\.(\d+))?-C(\d+)-B(\d+)(?:-A(\d+))?$/);
    if (tagMatch) {
        const releaseNumMain = parseInt(tagMatch[1]);
        const releaseNumMinor = tagMatch[2] ? parseInt(tagMatch[2]) : 0;
        const candidateNum = parseInt(tagMatch[3]);
        const betaNum = parseInt(tagMatch[4]);
        const alphaNum = tagMatch[5] ? parseInt(tagMatch[5]) : 0;

        //////// Подсчёт общего номера версии для сортировки
        //////// Приоритет: releaseNumMain → releaseNumMinor → candidateNum → betaNum → alphaNum
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

////// Функция для определения следующего тега
function getNextAlphaTag(lastTag) {
    let releaseNumMain = 1;
    let releaseNumMinor = 0;
    let candidateNum = 1;
    let betaNum = 1;
    let alphaNum = 1;

    //////// Получение предыдущего тега и увеличение нужных показателей, чтобы получить версию формата X.Y-CZ-BZ-AZ
    if (lastTag) {
        const devMatch = lastTag.match(/^dev(\d+)$/);
        const tagMatch = lastTag.match(/^(\d+)(?:\.(\d+))?-C(\d+)-B(\d+)(?:-A(\d+))?$/);

        if (devMatch) {
            //////// Увеличение номера альфы, если предыдущий тег — пререлиз
            alphaNum = parseInt(devMatch[1]) + 1;
        } else if (tagMatch) {
            releaseNumMain = parseInt(tagMatch[1]);
            releaseNumMinor = tagMatch[2] ? parseInt(tagMatch[2]) : 0;
            candidateNum = parseInt(tagMatch[3]);
            betaNum = parseInt(tagMatch[4]);

            if (tagMatch[5]) {
                //////// Увеличение номера альфы, если предыдущий тег — альфа-версия
                alphaNum = parseInt(tagMatch[5]) + 1;
            } else {
                //////// Увеличение номера беты и сброс номера альфы, если предыдущий тег — бета-версия
                betaNum += 1;
                alphaNum = 1;
            }
        }
    }

    //////// Формирование новой строки: 1.0-C1-B1-A1
    let releaseNumPart = `${releaseNumMain}.${releaseNumMinor}`;
    const newTag = `${releaseNumPart}-C${candidateNum}-B${betaNum}-A${alphaNum}`;
    const title = `${alphaNum}-я альфа`;

    //////// Возврат структуры с новым тегом и его описанием
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

////// Функция для получения списка изменённых файлов
function getChangedFiles(lastTag) {
    //////// Выполнение команды git diff, чтобы узнать, какие файлы изменились с момента предыдущего тега
    //////// Возвращение списка объектов с полями status и filePath

    let diffCommand = 'git -c core.quotepath=false -c i18n.logOutputEncoding=UTF-8 diff --name-status';
    if (lastTag) {
        diffCommand += ` ${lastTag} HEAD`;
    } else {
        //////// Получение изменения в последней правке, если предыдущего тега нет
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

////// Функция для получения информации об изменениях модов
async function getModChanges(changedFiles, sheets) {
    const modChanges = [];
    const newGameVersions = [];

    for (const file of changedFiles) {
        const decodedFilePath = file.filePath;

        //////// Обнаружение добавления нового pack.mcmeta (начата поддержка новой версии игры)
        const packMcmetaMatch = decodedFilePath.match(/^Набор ресурсов\/([^/]+)\/pack\.mcmeta$/);
        if (packMcmetaMatch && file.status.startsWith('A')) {
            const gameVer = packMcmetaMatch[1];
            newGameVersions.push(gameVer);
            continue;
        }

        // Подхватывание изменений в папках lang и book модов: например,
        // «Набор ресурсов/1.20/assets/alexsmobs/lang/…» или
        // «Набор ресурсов/1.20/assets/alexsmobs/book/…»
        const langOrBookMatch = decodedFilePath.match(/^Набор ресурсов\/([^/]+)\/assets\/([^/]+)\/(lang|book)\/.+\.(json|lang|txt|xml)$/i);
        if (langOrBookMatch) {
            const gameVer = langOrBookMatch[1];
            const modId = langOrBookMatch[2];
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

// В getModInfoFromSheet(…) нормализуется как сохранённое название строки, так и запрошенный
// идентификатор мода, чтобы «alexsmobs» могло соответствовать «Alex's Mobs», если идентификатора мода 
// нет. Также, если найдено несколько соответствий, выбирается строка с наивысшим значением популярности.
async function getModInfoFromSheet(modId, gameVer, sheets) {
    const spreadsheetId = '1kGGT2GGdG_Ed13gQfn01tDq2MZlVOC9AoiD1s3SDlZE';
    const range = 'db!A1:Z1500';

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

    // Нормализация идентификатора мода (удаление пробелов, апострофов, приведение в нижний регистр 
    // и так далее)
    const normalizedModId = modId.trim().toLowerCase().replace(/[ '\']/g, '');

    // Сборка всех возможных совпадений
    const possibleMatches = [];
    for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        if (!row) continue;

        const rowIdRaw = row[idIndex] ? row[idIndex].trim().toLowerCase() : '';
        const rowNameRaw = row[nameIndex] ? row[nameIndex].trim().toLowerCase() : '';
        // Удаление пробелов, апострофов из сырого названия строки
        const rowNameNormalized = rowNameRaw.replace(/[ '\']/g, '');
        const rowGameVerRaw = row[gameVerIndex] ? row[gameVerIndex].trim().toLowerCase() : '';

        // Если в строке есть идентификатор, проверить точное совпадение. В ином случае проверить 
        // схожесть названий.
        const idMatches = rowIdRaw === normalizedModId;
        const nameMatches =
            (!rowIdRaw && rowNameNormalized.includes(normalizedModId)) ||
            rowNameNormalized === normalizedModId;

        if (idMatches || nameMatches) {
            let popularityVal = 0;
            if (popularityIndex !== -1 && row[popularityIndex]) {
                // Конвертировать значение популярности в значение с плавающей запятой или оставить
                // как 0, если не выйдет
                popularityVal = parseFloat(
                    row[popularityIndex].toString().replace(/\s/g, '').replace(',', '.')
                ) || 0;
            }

            possibleMatches.push({
                row,
                rowGameVerRaw,
                popularity: popularityVal,
            });
        }
    }

    // Если совпадений нет, вернуть null
    if (possibleMatches.length === 0) return null;

    // Среди возможных совпадений сначала попробовать найти все строки, rowGameVerRaw которых начинается 
    // с gameVer (например, «1.19»). Если будет несколько совпадений, выбрать то, что с наивысшей 
    // популярностью.
    const normalizedGameVer = gameVer.toLowerCase();
    const versionBasedMatches = possibleMatches.filter(entry =>
        entry.rowGameVerRaw.startsWith(normalizedGameVer)
    );

    let bestMatch = null;
    if (versionBasedMatches.length > 0) {
        // Сортировка по популярности
        versionBasedMatches.sort((a, b) => b.popularity - a.popularity);
        bestMatch = versionBasedMatches[0];
    } else {
        // Если ничего не совпало с версией, просто выбрать строку с наивысшим значением популярности 
        // среди всех остальных совпадений
        possibleMatches.sort((a, b) => b.popularity - a.popularity);
        bestMatch = possibleMatches[0];
    }

    const bestRow = bestMatch.row;
    const rowName = bestRow[nameIndex] || modId;
    const modrinthUrl = bestRow[modrinthUrlIndex] || '';
    const cfUrl = bestRow[cfUrlIndex] || '';
    const fallbackUrl = bestRow[fallbackUrlIndex] || '';
    const url = modrinthUrl || cfUrl || fallbackUrl;

    return {
        name: rowName,
        url,
        popularity: bestMatch.popularity,
    };
}

// Функция для генерации описания выпуска
async function generateReleaseNotes(changedFiles, sheets, nextTagInfo, lastTag) {
    let finalList = `Это ${nextTagInfo.alphaNum}-я альфа-версия всех переводов проекта.\n\n`;

    if (lastTag && /^dev\d+$/.test(lastTag)) {
        finalList += `Пререлизы были упразднены! Теперь пререлизы зовутся альфами. Про то, как теперь выходят ранние версии проекта, можете прочитать [здесь](https://github.com/RushanM/Minecraft-Mods-Russian-Translation/blob/beta/%D0%A0%D1%83%D0%BA%D0%BE%D0%B2%D0%BE%D0%B4%D1%81%D1%82%D0%B2%D0%BE/%D0%98%D0%BC%D0%B5%D0%BD%D0%BE%D0%B2%D0%B0%D0%BD%D0%B8%D0%B5%20%D0%B2%D1%8B%D0%BF%D1%83%D1%81%D0%BA%D0%BE%D0%B2.md).\n\n`;
    } else {
        // Стандартный текст
        finalList += `Про то, как выходят ранние версии проекта, можете прочитать [здесь](https://github.com/RushanM/Minecraft-Mods-Russian-Translation/blob/beta/%D0%A0%D1%83%D0%BA%D0%BE%D0%B2%D0%BE%D0%B4%D1%81%D1%82%D0%B2%D0%BE/%D0%98%D0%BC%D0%B5%D0%BD%D0%BE%D0%B2%D0%B0%D0%BD%D0%B8%D0%B5%20%D0%B2%D1%8B%D0%BF%D1%83%D1%81%D0%BA%D0%BE%D0%B2.md).\n\n`;
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
        const key = `${change.name}::${change.url}`;

        // При формировании grouped запоминаем change, чтобы потом взять action и popularity:
        if (!grouped[key]) {
            grouped[key] = [];
        }
        grouped[key].push(change);
    });

    // Далее, при преобразовании в список, собираем версии и решаем, какой action использовать
    let groupedList = Object.keys(grouped).map(key => {
        // В key у нас: name и url
        const [name, url] = key.split('::');

        // Собираем все записи одного мода
        const changesForMod = grouped[key];

        // Версии
        const versions = changesForMod.map(ch => {
            const num = parseFloat(ch.gameVer) || 0;
            return { original: ch.gameVer, numeric: num };
        });

        // Решаем, какой action в итоге ставить
        // Например, если хоть одна версия была добавлена, считаем action - «добавлен»,
        // в ином случае «изменён»
        let finalAction = changesForMod.some(ch => ch.action === 'добавлен')
            ? 'добавлен'
            : 'изменён';

        // Берём наивысшую популярность
        const popularityVal = Math.max(...changesForMod.map(ch => ch.popularity));

        return {
            action: finalAction,
            name,
            url,
            popularity: popularityVal,
            versions,
        };
    });

    // Сортируем по популярности, затем по названию
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

        // Преобразуем единственную или диапазон версий в удобочитаемый вид
        let versionText;
        if (versions.length === 1) {
            versionText =
                versions[0].original === 'b1.7.3'
                    ? versions[0].original
                    : `${versions[0].original}.x`;
        } else {
            const start = versions[0].original;
            const end = versions[versions.length - 1].original;
            if (start === end) {
                versionText =
                    start === 'b1.7.3' ? start : `${start}.x`;
            } else {
                const startLabel = start === 'b1.7.3' ? start : `${start}.x`;
                const endLabel = end === 'b1.7.3' ? end : `${end}.x`;
                versionText = `${startLabel} — ${endLabel}`;
            }
        }

        const line = `${action} перевод мода [${name}](${url}) на Minecraft ${versionText}`;
        allChanges.push(line);
    }

    // Ниже идёт логика формирования финального списка изменений
    // с использованием эмодзи, подсписков и спойлеров.

    // Подготовим массивы для трёх типов изменений:
    const flagChanges = [];       // «начат перевод...»
    const addedChanges = [];      // «добавлен перевод...»
    const modifiedChanges = [];   // «изменён перевод...»

    // Разложим allChanges по категориям:
    for (const item of allChanges) {
        // Для b1.7.3 мы ищем начало строки «начат перевод»
        if (item.startsWith('начат перевод модов для Minecraft')) {
            // Заменяем на «🚩…»
            const replaced = item.replace('начат перевод', '🚩 начат перевод');
            flagChanges.push(replaced);
            continue;
        }
        // Для добавленных
        if (item.startsWith('добавлен перевод мода')) {
            // Уберём «добавлен перевод мода», а оставим всё после него
            // например: «добавлен перевод мода [Xaero's…] на Minecraft 1.21.x»
            addedChanges.push(item.replace('добавлен перевод мода ', ''));
            continue;
        }
        // Для изменённых
        if (item.startsWith('изменён перевод мода')) {
            modifiedChanges.push(item.replace('изменён перевод мода ', ''));
            continue;
        }

        // Если по какой-то причине что-то не подошло, просто кладём в modifiedChanges
        // (или можно положить в отдельную категорию)
        modifiedChanges.push(item);
    }

    // Начинаем формировать итоговый блок: «Изменения в этой версии:»
    if (allChanges.length > 1) {
        finalList += `Изменения в этой версии:\n\n`;
    }

    // 1) Начат перевод (флажок) — каждая строка отдельный пункт
    for (const fc of flagChanges) {
        finalList += `* ${fc},\n`;
    }

    // Подсчитываем общее количество пунктов в списке
    const totalItems = addedChanges.length + modifiedChanges.length;
    let currentIndex = 0; // Будем увеличивать при выводе каждого пункта

    // 2) Добавленные переводы
    if (addedChanges.length === 1) {
        finalList += `* 🆕 добавлен перевод мода ${addedChanges[0]}${totalItems === 1 ? '.' : ','}\n`;
        currentIndex++;
    } else if (addedChanges.length > 1) {
        // Если больше одного — делаем подсписок
        // Проверяем, нужно ли складывать список в спойлер (если > 8)
        finalList += `* 🆕 добавлены переводы модов:\n`;

        // Если хотим использовать спойлер (пример > 8)
        if (addedChanges.length > 8) {
            finalList += `\t<details>\n\t<summary>Раскрыть</summary>\n\t<br>\n\n`;
        }

        for (let i = 0; i < addedChanges.length; i++) {
            currentIndex++;
            // Проверяем, является ли это последний пункт *во всём* списке
            const endChar = currentIndex === totalItems ? '.' : ',';
            finalList += `\t* ${addedChanges[i]}${endChar}\n`;
        }

        if (addedChanges.length > 8) {
            finalList += `\n\t</details>\n`;
        }
    }

    // 3) Изменённые переводы
    if (modifiedChanges.length === 1) {
        currentIndex++;
        // Если этот элемент последний во всём списке — ставим точку, иначе — запятую
        const endChar = currentIndex === totalItems ? '.' : ',';
        finalList += `* 💱 изменён перевод мода ${modifiedChanges[0]}${endChar}\n`;
    } else if (modifiedChanges.length > 1) {
        // Если больше одного — делаем подсписок
        finalList += `* 💱 изменены переводы модов:\n`;

        // Спойлер, если более 8
        if (modifiedChanges.length > 8) {
            finalList += `\t<details>\n\t<summary>Раскрыть</summary>\n\t<br>\n\n`;
        }

        for (let i = 0; i < modifiedChanges.length; i++) {
            currentIndex++;
            const endChar = currentIndex === totalItems ? '.' : ',';
            finalList += `\t* ${modifiedChanges[i]}${endChar}\n`;
        }

        if (modifiedChanges.length > 8) {
            finalList += `\n\t</details>\n`;
        } else {
            finalList += `* 💱 изменены переводы модов:\n`;
            for (let i = 0; i < modifiedChanges.length; i++) {
                finalList += `\t* ${modifiedChanges[i]}${i === modifiedChanges.length - 1 ? '.' : ','}\n`;
            }
        }
    }

    // Убираем лишнюю запятую/перенос в конце, если остался
    finalList = finalList.trim();

    return finalList;
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