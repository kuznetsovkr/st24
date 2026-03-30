type BoxType = {
  id: string;
  name: string;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
  maxWeightGrams: number;
  emptyWeightGrams: number;
  fillRatio: number;
  sortOrder: number;
};

type UnitItem = {
  sourceId?: string;
  sourceName: string;
  sourceItemIndex: number;
  unitIndex: number;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
  weightGrams: number;
  volumeCm3: number;
};

type BoxState = {
  type: BoxType;
  totalWeightGrams: number;
  totalVolumeCm3: number;
  items: UnitItem[];
};

export type ShippingParcel = {
  length: number;
  width: number;
  height: number;
  weight: number;
};

export type PackableCartItem = {
  id?: string;
  name?: string;
  quantity: number;
  weightGrams?: number;
  lengthCm?: number;
  widthCm?: number;
  heightCm?: number;
};

export type ShippingBoxType = {
  id: string;
  name: string;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
  maxWeightGrams: number;
  emptyWeightGrams: number;
  fillRatio: number;
  sortOrder?: number;
};

export type PackingDebugBox = {
  boxType: ShippingBoxType;
  parcel: ShippingParcel;
  usedWeightGrams: number;
  usedVolumeCm3: number;
  capacityVolumeCm3: number;
  maxAllowedVolumeCm3: number;
  items: UnitItem[];
};

export type PackingDebugFallbackParcel = {
  parcel: ShippingParcel;
  item: UnitItem;
  reason: 'no_matching_box_type' | 'soft_package_small_volume';
};

export type PackingDebugResult = {
  boxTypes: ShippingBoxType[];
  units: UnitItem[];
  boxes: PackingDebugBox[];
  fallbackParcels: PackingDebugFallbackParcel[];
  parcels: ShippingParcel[];
};

const DEFAULT_ITEM = {
  lengthCm: 10,
  widthCm: 10,
  heightCm: 10,
  weightGrams: 500
};

const BOX_VOLUME_OVERFLOW_RATIO = 0.1;
const VOLUMETRIC_DIVISOR_CM3_PER_KG = 5000;
const SOFT_PACKAGE_MAX_VOLUMETRIC_KG = 1;

const DEFAULT_BOX_TYPES: BoxType[] = [
  {
    id: 's',
    name: 'S',
    lengthCm: 20,
    widthCm: 15,
    heightCm: 10,
    maxWeightGrams: 2000,
    emptyWeightGrams: 120,
    fillRatio: 0.82,
    sortOrder: 0
  },
  {
    id: 'm',
    name: 'M',
    lengthCm: 30,
    widthCm: 22,
    heightCm: 14,
    maxWeightGrams: 5000,
    emptyWeightGrams: 180,
    fillRatio: 0.82,
    sortOrder: 1
  },
  {
    id: 'l',
    name: 'L',
    lengthCm: 40,
    widthCm: 30,
    heightCm: 20,
    maxWeightGrams: 10000,
    emptyWeightGrams: 260,
    fillRatio: 0.8,
    sortOrder: 2
  },
  {
    id: 'xl',
    name: 'XL',
    lengthCm: 60,
    widthCm: 40,
    heightCm: 30,
    maxWeightGrams: 20000,
    emptyWeightGrams: 420,
    fillRatio: 0.78,
    sortOrder: 3
  }
];

const sortDimsDesc = (lengthCm: number, widthCm: number, heightCm: number) =>
  [lengthCm, widthCm, heightCm].sort((a, b) => b - a);

const calcVolume = (lengthCm: number, widthCm: number, heightCm: number) =>
  lengthCm * widthCm * heightCm;

const normalizePositiveInt = (value: number | undefined, fallback: number) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  const rounded = Math.round(value);
  if (rounded < 1) {
    return fallback;
  }
  return rounded;
};

const normalizeUnit = (item: PackableCartItem, sourceItemIndex: number, unitIndex: number): UnitItem => {
  const lengthCm = normalizePositiveInt(item.lengthCm, DEFAULT_ITEM.lengthCm);
  const widthCm = normalizePositiveInt(item.widthCm, DEFAULT_ITEM.widthCm);
  const heightCm = normalizePositiveInt(item.heightCm, DEFAULT_ITEM.heightCm);
  const weightGrams = normalizePositiveInt(item.weightGrams, DEFAULT_ITEM.weightGrams);
  return {
    sourceId: item.id,
    sourceName: item.name?.trim() || item.id || `Товар ${sourceItemIndex + 1}`,
    sourceItemIndex,
    unitIndex,
    lengthCm,
    widthCm,
    heightCm,
    weightGrams,
    volumeCm3: calcVolume(lengthCm, widthCm, heightCm)
  };
};

const normalizeBoxTypes = (input?: ShippingBoxType[]): BoxType[] => {
  if (!Array.isArray(input) || input.length === 0) {
    return DEFAULT_BOX_TYPES;
  }

  const normalized = input
    .map((item, index) => {
      const lengthCm = normalizePositiveInt(item.lengthCm, 0);
      const widthCm = normalizePositiveInt(item.widthCm, 0);
      const heightCm = normalizePositiveInt(item.heightCm, 0);
      const maxWeightGrams = normalizePositiveInt(item.maxWeightGrams, 0);
      const emptyWeightGrams = normalizePositiveInt(item.emptyWeightGrams, 0);
      const fillRatio =
        typeof item.fillRatio === 'number' && Number.isFinite(item.fillRatio)
          ? Math.round(item.fillRatio * 100) / 100
          : 0;
      const sortOrder =
        typeof item.sortOrder === 'number' && Number.isFinite(item.sortOrder)
          ? Math.round(item.sortOrder)
          : index;

      if (
        !item.id ||
        !item.name ||
        lengthCm < 1 ||
        widthCm < 1 ||
        heightCm < 1 ||
        maxWeightGrams < 1 ||
        emptyWeightGrams < 0 ||
        fillRatio <= 0 ||
        fillRatio > 1
      ) {
        return null;
      }

      return {
        id: item.id,
        name: item.name,
        lengthCm,
        widthCm,
        heightCm,
        maxWeightGrams,
        emptyWeightGrams,
        fillRatio,
        sortOrder
      } satisfies BoxType;
    })
    .filter((item): item is BoxType => item !== null)
    .sort((a, b) => {
      if (a.sortOrder !== b.sortOrder) {
        return a.sortOrder - b.sortOrder;
      }
      return calcVolume(a.lengthCm, a.widthCm, a.heightCm) - calcVolume(b.lengthCm, b.widthCm, b.heightCm);
    });

  return normalized.length > 0 ? normalized : DEFAULT_BOX_TYPES;
};

const fitsDimensions = (unit: UnitItem, box: BoxType) => {
  const itemDims = sortDimsDesc(unit.lengthCm, unit.widthCm, unit.heightCm);
  const boxDims = sortDimsDesc(box.lengthCm, box.widthCm, box.heightCm);
  return (
    itemDims[0] <= boxDims[0] &&
    itemDims[1] <= boxDims[1] &&
    itemDims[2] <= boxDims[2]
  );
};

const boxCapacityVolume = (box: BoxType) =>
  Math.floor(calcVolume(box.lengthCm, box.widthCm, box.heightCm) * box.fillRatio);

const boxMaxAllowedVolume = (box: BoxType) =>
  Math.floor(boxCapacityVolume(box) * (1 + BOX_VOLUME_OVERFLOW_RATIO));

const canPlaceIntoBox = (boxState: BoxState, unit: UnitItem) => {
  if (!fitsDimensions(unit, boxState.type)) {
    return false;
  }
  if (boxState.totalWeightGrams + unit.weightGrams > boxState.type.maxWeightGrams) {
    return false;
  }
  if (boxState.totalVolumeCm3 + unit.volumeCm3 > boxMaxAllowedVolume(boxState.type)) {
    return false;
  }
  return true;
};

const pickBoxForUnit = (unit: UnitItem, boxTypes: BoxType[]) => {
  const fit = boxTypes.find(
    (box) =>
      fitsDimensions(unit, box) &&
      unit.weightGrams <= box.maxWeightGrams &&
      unit.volumeCm3 <= boxMaxAllowedVolume(box)
  );
  if (fit) {
    return fit;
  }
  return null;
};

const toParcel = (boxState: BoxState): ShippingParcel => ({
  length: boxState.type.lengthCm,
  width: boxState.type.widthCm,
  height: boxState.type.heightCm,
  weight: Math.max(1, boxState.totalWeightGrams + boxState.type.emptyWeightGrams)
});

const toFallbackParcel = (unit: UnitItem): ShippingParcel => ({
  length: Math.max(1, unit.lengthCm + 2),
  width: Math.max(1, unit.widthCm + 2),
  height: Math.max(1, unit.heightCm + 2),
  weight: Math.max(1, unit.weightGrams + 150)
});

const toUnitParcel = (unit: UnitItem): ShippingParcel => ({
  length: unit.lengthCm,
  width: unit.widthCm,
  height: unit.heightCm,
  weight: unit.weightGrams
});

const shouldShipInSoftPackage = (units: UnitItem[]) => {
  const totalVolumeCm3 = units.reduce((sum, unit) => sum + unit.volumeCm3, 0);
  const volumetricWeightKg = totalVolumeCm3 / VOLUMETRIC_DIVISOR_CM3_PER_KG;
  return volumetricWeightKg < SOFT_PACKAGE_MAX_VOLUMETRIC_KG;
};

export const buildShippingPackingDebug = (
  items: PackableCartItem[],
  boxTypes?: ShippingBoxType[]
): PackingDebugResult => {
  const availableBoxTypes = normalizeBoxTypes(boxTypes);
  const units: UnitItem[] = [];
  for (let sourceItemIndex = 0; sourceItemIndex < items.length; sourceItemIndex += 1) {
    const item = items[sourceItemIndex];
    const quantity = Math.max(0, Math.round(item.quantity));
    if (quantity === 0) {
      continue;
    }
    for (let i = 0; i < quantity; i += 1) {
      units.push(normalizeUnit(item, sourceItemIndex, i + 1));
    }
  }

  if (units.length === 0) {
    const defaultParcel = {
        length: 30,
        width: 20,
        height: 15,
        weight: 500
      };
    return {
      boxTypes: availableBoxTypes,
      units: [],
      boxes: [],
      fallbackParcels: [],
      parcels: [defaultParcel]
    };
  }

  if (shouldShipInSoftPackage(units)) {
    const softPackageParcels = units.map((unit) => ({
      parcel: toUnitParcel(unit),
      item: unit,
      reason: 'soft_package_small_volume' as const
    }));
    return {
      boxTypes: availableBoxTypes,
      units,
      boxes: [],
      fallbackParcels: softPackageParcels,
      parcels: softPackageParcels.map((item) => item.parcel)
    };
  }

  units.sort((a, b) => b.volumeCm3 - a.volumeCm3 || b.weightGrams - a.weightGrams);

  const boxStates: BoxState[] = [];
  const fallbackParcels: PackingDebugFallbackParcel[] = [];

  for (const unit of units) {
    let selectedIndex = -1;
    let bestRemainingVolume = Number.POSITIVE_INFINITY;

    for (let i = 0; i < boxStates.length; i += 1) {
      const boxState = boxStates[i];
      if (!canPlaceIntoBox(boxState, unit)) {
        continue;
      }
      const remaining =
        boxMaxAllowedVolume(boxState.type) - (boxState.totalVolumeCm3 + unit.volumeCm3);
      if (remaining < bestRemainingVolume) {
        selectedIndex = i;
        bestRemainingVolume = remaining;
      }
    }

    if (selectedIndex >= 0) {
      boxStates[selectedIndex].totalWeightGrams += unit.weightGrams;
      boxStates[selectedIndex].totalVolumeCm3 += unit.volumeCm3;
      boxStates[selectedIndex].items.push(unit);
      continue;
    }

    const newBoxType = pickBoxForUnit(unit, availableBoxTypes);
    if (!newBoxType) {
      fallbackParcels.push({
        parcel: toFallbackParcel(unit),
        item: unit,
        reason: 'no_matching_box_type'
      });
      continue;
    }

    boxStates.push({
      type: newBoxType,
      totalWeightGrams: unit.weightGrams,
      totalVolumeCm3: unit.volumeCm3,
      items: [unit]
    });
  }

  const boxes: PackingDebugBox[] = boxStates.map((boxState) => ({
    boxType: boxState.type,
    parcel: toParcel(boxState),
    usedWeightGrams: boxState.totalWeightGrams,
    usedVolumeCm3: boxState.totalVolumeCm3,
    capacityVolumeCm3: boxCapacityVolume(boxState.type),
    maxAllowedVolumeCm3: boxMaxAllowedVolume(boxState.type),
    items: boxState.items
  }));

  return {
    boxTypes: availableBoxTypes,
    units,
    boxes,
    fallbackParcels,
    parcels: [...boxes.map((box) => box.parcel), ...fallbackParcels.map((item) => item.parcel)]
  };
};

export const buildShippingParcels = (
  items: PackableCartItem[],
  boxTypes?: ShippingBoxType[]
): ShippingParcel[] => buildShippingPackingDebug(items, boxTypes).parcels;
