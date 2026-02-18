type BoxType = {
  id: string;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
  maxWeightGrams: number;
  emptyWeightGrams: number;
  fillRatio: number;
};

type UnitItem = {
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
};

export type ShippingParcel = {
  length: number;
  width: number;
  height: number;
  weight: number;
};

export type PackableCartItem = {
  quantity: number;
  weightGrams?: number;
  lengthCm?: number;
  widthCm?: number;
  heightCm?: number;
};

const DEFAULT_ITEM = {
  lengthCm: 10,
  widthCm: 10,
  heightCm: 10,
  weightGrams: 500
};

const BOX_TYPES: BoxType[] = [
  {
    id: 's',
    lengthCm: 20,
    widthCm: 15,
    heightCm: 10,
    maxWeightGrams: 2000,
    emptyWeightGrams: 120,
    fillRatio: 0.82
  },
  {
    id: 'm',
    lengthCm: 30,
    widthCm: 22,
    heightCm: 14,
    maxWeightGrams: 5000,
    emptyWeightGrams: 180,
    fillRatio: 0.82
  },
  {
    id: 'l',
    lengthCm: 40,
    widthCm: 30,
    heightCm: 20,
    maxWeightGrams: 10000,
    emptyWeightGrams: 260,
    fillRatio: 0.8
  },
  {
    id: 'xl',
    lengthCm: 60,
    widthCm: 40,
    heightCm: 30,
    maxWeightGrams: 20000,
    emptyWeightGrams: 420,
    fillRatio: 0.78
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

const normalizeUnit = (item: PackableCartItem): UnitItem => {
  const lengthCm = normalizePositiveInt(item.lengthCm, DEFAULT_ITEM.lengthCm);
  const widthCm = normalizePositiveInt(item.widthCm, DEFAULT_ITEM.widthCm);
  const heightCm = normalizePositiveInt(item.heightCm, DEFAULT_ITEM.heightCm);
  const weightGrams = normalizePositiveInt(item.weightGrams, DEFAULT_ITEM.weightGrams);
  return {
    lengthCm,
    widthCm,
    heightCm,
    weightGrams,
    volumeCm3: calcVolume(lengthCm, widthCm, heightCm)
  };
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

const canPlaceIntoBox = (boxState: BoxState, unit: UnitItem) => {
  if (!fitsDimensions(unit, boxState.type)) {
    return false;
  }
  if (boxState.totalWeightGrams + unit.weightGrams > boxState.type.maxWeightGrams) {
    return false;
  }
  if (boxState.totalVolumeCm3 + unit.volumeCm3 > boxCapacityVolume(boxState.type)) {
    return false;
  }
  return true;
};

const pickBoxForUnit = (unit: UnitItem) => {
  const fit = BOX_TYPES.find(
    (box) =>
      fitsDimensions(unit, box) &&
      unit.weightGrams <= box.maxWeightGrams &&
      unit.volumeCm3 <= boxCapacityVolume(box)
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

export const buildShippingParcels = (items: PackableCartItem[]): ShippingParcel[] => {
  const units: UnitItem[] = [];
  for (const item of items) {
    const quantity = Math.max(0, Math.round(item.quantity));
    if (quantity === 0) {
      continue;
    }
    const unit = normalizeUnit(item);
    for (let i = 0; i < quantity; i += 1) {
      units.push(unit);
    }
  }

  if (units.length === 0) {
    return [
      {
        length: 30,
        width: 20,
        height: 15,
        weight: 500
      }
    ];
  }

  units.sort((a, b) => b.volumeCm3 - a.volumeCm3 || b.weightGrams - a.weightGrams);

  const boxStates: BoxState[] = [];
  const fallbackParcels: ShippingParcel[] = [];

  for (const unit of units) {
    let selectedIndex = -1;
    let bestRemainingVolume = Number.POSITIVE_INFINITY;

    for (let i = 0; i < boxStates.length; i += 1) {
      const boxState = boxStates[i];
      if (!canPlaceIntoBox(boxState, unit)) {
        continue;
      }
      const remaining =
        boxCapacityVolume(boxState.type) - (boxState.totalVolumeCm3 + unit.volumeCm3);
      if (remaining < bestRemainingVolume) {
        selectedIndex = i;
        bestRemainingVolume = remaining;
      }
    }

    if (selectedIndex >= 0) {
      boxStates[selectedIndex].totalWeightGrams += unit.weightGrams;
      boxStates[selectedIndex].totalVolumeCm3 += unit.volumeCm3;
      continue;
    }

    const newBoxType = pickBoxForUnit(unit);
    if (!newBoxType) {
      fallbackParcels.push(toFallbackParcel(unit));
      continue;
    }

    boxStates.push({
      type: newBoxType,
      totalWeightGrams: unit.weightGrams,
      totalVolumeCm3: unit.volumeCm3
    });
  }

  return [...boxStates.map(toParcel), ...fallbackParcels];
};
