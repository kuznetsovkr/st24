import { createHash } from 'crypto';
import type { BoxTypeRow } from './db/boxTypes';
import type { CartItemRow } from './db/cart';

export type ShippingParcel = {
  length: number;
  width: number;
  height: number;
  weight: number;
};

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

const DEFAULT_ITEM = {
  lengthCm: 10,
  widthCm: 10,
  heightCm: 10,
  weightGrams: 500
};

const DEFAULT_PARCEL: ShippingParcel = {
  length: 30,
  width: 20,
  height: 15,
  weight: 500
};

const BOX_VOLUME_OVERFLOW_RATIO = 0.1;

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

const normalizePositiveInt = (value: unknown, fallback: number) => {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
      ? Number.parseFloat(value)
      : Number.NaN;
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  const rounded = Math.round(parsed);
  return rounded > 0 ? rounded : fallback;
};

const calcVolume = (lengthCm: number, widthCm: number, heightCm: number) =>
  lengthCm * widthCm * heightCm;

const sortDimsDesc = (lengthCm: number, widthCm: number, heightCm: number) =>
  [lengthCm, widthCm, heightCm].sort((a, b) => b - a);

const normalizeBoxTypes = (input: BoxTypeRow[]): BoxType[] => {
  if (!Array.isArray(input) || input.length === 0) {
    return DEFAULT_BOX_TYPES;
  }

  const normalized = input
    .map((item, index) => {
      const lengthCm = normalizePositiveInt(item.length_cm, 0);
      const widthCm = normalizePositiveInt(item.width_cm, 0);
      const heightCm = normalizePositiveInt(item.height_cm, 0);
      const maxWeightGrams = normalizePositiveInt(item.max_weight_grams, 0);
      const emptyWeightGrams = Math.max(0, normalizePositiveInt(item.empty_weight_grams, 0));
      const fillRatio =
        typeof item.fill_ratio === 'number' && Number.isFinite(item.fill_ratio)
          ? Math.round(item.fill_ratio * 100) / 100
          : 0;
      const sortOrder =
        typeof item.sort_order === 'number' && Number.isFinite(item.sort_order)
          ? Math.round(item.sort_order)
          : index;

      if (
        lengthCm < 1 ||
        widthCm < 1 ||
        heightCm < 1 ||
        maxWeightGrams < 1 ||
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
      return (
        calcVolume(a.lengthCm, a.widthCm, a.heightCm) -
        calcVolume(b.lengthCm, b.widthCm, b.heightCm)
      );
    });

  return normalized.length > 0 ? normalized : DEFAULT_BOX_TYPES;
};

const normalizeCartUnits = (items: CartItemRow[]): UnitItem[] => {
  const units: UnitItem[] = [];

  for (const item of items) {
    const quantity = Math.max(0, Math.round(item.quantity));
    if (quantity === 0) {
      continue;
    }

    const lengthCm = normalizePositiveInt(item.length_cm, DEFAULT_ITEM.lengthCm);
    const widthCm = normalizePositiveInt(item.width_cm, DEFAULT_ITEM.widthCm);
    const heightCm = normalizePositiveInt(item.height_cm, DEFAULT_ITEM.heightCm);
    const weightGrams = normalizePositiveInt(item.weight_grams, DEFAULT_ITEM.weightGrams);
    const volumeCm3 = calcVolume(lengthCm, widthCm, heightCm);

    for (let i = 0; i < quantity; i += 1) {
      units.push({
        lengthCm,
        widthCm,
        heightCm,
        weightGrams,
        volumeCm3
      });
    }
  }

  units.sort((a, b) => b.volumeCm3 - a.volumeCm3 || b.weightGrams - a.weightGrams);
  return units;
};

const fitsDimensions = (unit: UnitItem, box: BoxType) => {
  const itemDims = sortDimsDesc(unit.lengthCm, unit.widthCm, unit.heightCm);
  const boxDims = sortDimsDesc(box.lengthCm, box.widthCm, box.heightCm);
  return itemDims[0] <= boxDims[0] && itemDims[1] <= boxDims[1] && itemDims[2] <= boxDims[2];
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

const pickBoxForUnit = (unit: UnitItem, boxTypes: BoxType[]) =>
  boxTypes.find(
    (box) =>
      fitsDimensions(unit, box) &&
      unit.weightGrams <= box.maxWeightGrams &&
      unit.volumeCm3 <= boxMaxAllowedVolume(box)
  ) ?? null;

const toBoxParcel = (boxState: BoxState): ShippingParcel => ({
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

const normalizeParcel = (parcel: ShippingParcel): ShippingParcel => ({
  length: normalizePositiveInt(parcel.length, DEFAULT_PARCEL.length),
  width: normalizePositiveInt(parcel.width, DEFAULT_PARCEL.width),
  height: normalizePositiveInt(parcel.height, DEFAULT_PARCEL.height),
  weight: normalizePositiveInt(parcel.weight, DEFAULT_PARCEL.weight)
});

const parcelSort = (a: ShippingParcel, b: ShippingParcel) =>
  a.length - b.length ||
  a.width - b.width ||
  a.height - b.height ||
  a.weight - b.weight;

export const normalizeShippingParcels = (input: unknown): ShippingParcel[] => {
  const raw = Array.isArray(input) ? input : [];

  const parcels = raw
    .filter((item) => item && typeof item === 'object')
    .map((item) => {
      const record = item as Record<string, unknown>;
      return normalizeParcel({
        length: normalizePositiveInt(record.length, DEFAULT_PARCEL.length),
        width: normalizePositiveInt(record.width, DEFAULT_PARCEL.width),
        height: normalizePositiveInt(record.height, DEFAULT_PARCEL.height),
        weight: normalizePositiveInt(record.weight, DEFAULT_PARCEL.weight)
      });
    });

  return parcels.length > 0 ? parcels.sort(parcelSort) : [DEFAULT_PARCEL];
};

export const hashShippingParcels = (input: ShippingParcel[]): string => {
  const normalized = normalizeShippingParcels(input);
  const payload = JSON.stringify(normalized.sort(parcelSort));
  return createHash('sha256').update(payload).digest('hex');
};

export const buildShippingParcelsFromCart = (
  items: CartItemRow[],
  boxTypes: BoxTypeRow[]
): ShippingParcel[] => {
  const units = normalizeCartUnits(items);
  if (units.length === 0) {
    return [DEFAULT_PARCEL];
  }

  const availableBoxTypes = normalizeBoxTypes(boxTypes);
  const boxStates: BoxState[] = [];
  const fallback: ShippingParcel[] = [];

  for (const unit of units) {
    let selectedIndex = -1;
    let bestRemainingVolume = Number.POSITIVE_INFINITY;

    for (let i = 0; i < boxStates.length; i += 1) {
      const state = boxStates[i];
      if (!canPlaceIntoBox(state, unit)) {
        continue;
      }

      const remaining = boxMaxAllowedVolume(state.type) - (state.totalVolumeCm3 + unit.volumeCm3);
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

    const boxType = pickBoxForUnit(unit, availableBoxTypes);
    if (!boxType) {
      fallback.push(toFallbackParcel(unit));
      continue;
    }

    boxStates.push({
      type: boxType,
      totalWeightGrams: unit.weightGrams,
      totalVolumeCm3: unit.volumeCm3
    });
  }

  const parcels = [...boxStates.map(toBoxParcel), ...fallback];
  return parcels.length > 0 ? parcels.sort(parcelSort) : [DEFAULT_PARCEL];
};
