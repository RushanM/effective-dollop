---
navigation:
  parent: items-blocks-machines/items-blocks-machines-index.md
  title: Прессователь
  icon: inscriber
  position: 310
categories:
- machines
item_ids:
- ae2:inscriber
---

# The Inscriber

<BlockImage id="inscriber" scale="8" />

Прессователь используется для создания схем и [процессоров](processors.md) с помощью [пресс-форм](presses.md), а также для измельчения различных предметов в пыль.
Он может принимать как энергию AE2 (АЭ), так и энергию Fabric/Forge (ЭФ). Прессователь поддерживает многосторонность, что позволяет вставлять в него предметы с любой стороны. Для упрощения выбора сторон, его можно вращать с помощью <ItemLink id="certus_quartz_wrench" />.
Также его можно настроить на отправку всего созданного в соседние инвентари.

Размер буфера входа можно регулировать. Например, если вы хотите загружать материалы из одного инвентаря в большую группу прессователей, вам нужен маленький буфер, чтобы материалы распределялись между прессователями более равномерно (вместо того чтобы первый прессователь заполнялся до 64 единиц, а остальные оставались пустыми).

4 пресс-формы схем используются для создания [процессоров](processors.md).

<Row>
  <ItemImage id="silicon_press" scale="4" />

  <ItemImage id="logic_processor_press" scale="4" />

  <ItemImage id="calculation_processor_press" scale="4" />

  <ItemImage id="engineering_processor_press" scale="4" />
</Row>

Именную пресс-форму можно использовать для именования блоков подобно тому, как это делается в наковальне. Полезно для подписывания вещей в <ItemLink id="pattern_access_terminal" />.

<ItemImage id="name_press" scale="4" />

## Настройки

* The inscriber can be set to be sided (as explained below) or allow inputs to any slot from any side, with an internal filter deciding
    what goes where. While in non-sided mode, items cannot be extracted from the top and bottom slots.
* The inscriber can be set to push items into adjacent inventories.
* The size of the input buffer can be adjusted, the large option is for a standalone inscriber you feed manually, the
small option is to make large parallelized setups more viable.

## Интерфейс и многосторонность

When in sided mode, the inscriber filters what goes where by which side you insert or extract from.

![Inscriber GUI](../assets/diagrams/inscriber_gui.png) ![Inscriber Sides](../assets/diagrams/inscriber_sides.png)

A. **Top Input** accessed via the top side of the inscriber (items can be both pushed to and pulled from this slot)

B. **Center Input** inserted to via the left, right, front, and rear sides of the inscriber (items can only be pushed to this slot, not pulled from)

C. **Bottom Input** accessed via the bottom side of the inscriber (items can be both pushed to and pulled from this slot)

D. **Output** pulled from via the left, right, front, and rear sides of the inscriber (items can only be pulled from this slot, not pushed to)

## Простая автоматизация

As an example, the sidedness and rotateability mean you can semi-automate inscribers like so:

<GameScene zoom="4" background="transparent">
  <ImportStructure src="../assets/assemblies/inscriber_hopper_automation.snbt" />
  <IsometricCamera yaw="195" pitch="30" />
</GameScene>

Or just pipe into and out of the inscriber when in non-sided mode.

## Улучшения

The inscriber supports the following [upgrades](upgrade_cards.md):

*   <ItemLink id="speed_card" />

## Рецепт

<RecipeFor id="inscriber" />
