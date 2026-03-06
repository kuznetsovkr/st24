export type ShippingEstimateProvider = 'dellin' | 'russian_post';

export type ShippingEstimateParcel = {
  length: number;
  width: number;
  height: number;
  weight: number;
};

export type ShippingEstimateInput = {
  provider: ShippingEstimateProvider;
  parcels: ShippingEstimateParcel[];
  destinationCity?: string;
  destinationCode?: string;
  destinationAddress?: string;
};

export type ShippingEstimateResult = {
  provider: ShippingEstimateProvider;
  estimatedCostCents: number;
  currency: 'RUB';
  billedWeightKg: number;
  actualWeightKg: number;
  volumetricWeightKg: number;
};

type ProviderEstimateConfig = {
  baseCents: number;
  perKgCents: number;
  minCents: number;
  volumetricDivisor: number;
  oversizeCm: number;
  oversizeSurchargeCents: number;
  remoteMultiplier: number;
  localMultiplier: number;
};

const normalizePositiveNumber = (value: unknown, fallback: number) => {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
      ? Number.parseFloat(value)
      : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
};

const parseEnvFloat = (key: string, fallback: number) =>
  normalizePositiveNumber(process.env[key], fallback);

const parseEnvInt = (key: string, fallback: number) =>
  Math.round(parseEnvFloat(key, fallback));

const LOCAL_CITY_FALLBACK = 'красноярск';

const getLocalCity = () =>
  (process.env.SHIPPING_ESTIMATE_LOCAL_CITY ?? LOCAL_CITY_FALLBACK).trim().toLowerCase();

const getProviderConfig = (provider: ShippingEstimateProvider): ProviderEstimateConfig => {
  if (provider === 'dellin') {
    return {
      baseCents: parseEnvInt('DELLIN_ESTIMATE_BASE_CENTS', 49000),
      perKgCents: parseEnvInt('DELLIN_ESTIMATE_PER_KG_CENTS', 6500),
      minCents: parseEnvInt('DELLIN_ESTIMATE_MIN_CENTS', 49000),
      volumetricDivisor: parseEnvFloat('DELLIN_ESTIMATE_VOLUMETRIC_DIVISOR', 5000),
      oversizeCm: parseEnvInt('DELLIN_ESTIMATE_OVERSIZE_CM', 120),
      oversizeSurchargeCents: parseEnvInt('DELLIN_ESTIMATE_OVERSIZE_SURCHARGE_CENTS', 25000),
      remoteMultiplier: parseEnvFloat('DELLIN_ESTIMATE_REMOTE_MULTIPLIER', 1.25),
      localMultiplier: parseEnvFloat('DELLIN_ESTIMATE_LOCAL_MULTIPLIER', 1)
    };
  }

  return {
    baseCents: parseEnvInt('RUSSIAN_POST_ESTIMATE_BASE_CENTS', 35000),
    perKgCents: parseEnvInt('RUSSIAN_POST_ESTIMATE_PER_KG_CENTS', 9000),
    minCents: parseEnvInt('RUSSIAN_POST_ESTIMATE_MIN_CENTS', 35000),
    volumetricDivisor: parseEnvFloat('RUSSIAN_POST_ESTIMATE_VOLUMETRIC_DIVISOR', 4500),
    oversizeCm: parseEnvInt('RUSSIAN_POST_ESTIMATE_OVERSIZE_CM', 90),
    oversizeSurchargeCents: parseEnvInt(
      'RUSSIAN_POST_ESTIMATE_OVERSIZE_SURCHARGE_CENTS',
      18000
    ),
    remoteMultiplier: parseEnvFloat('RUSSIAN_POST_ESTIMATE_REMOTE_MULTIPLIER', 1.2),
    localMultiplier: parseEnvFloat('RUSSIAN_POST_ESTIMATE_LOCAL_MULTIPLIER', 1)
  };
};

const normalizeParcel = (parcel: ShippingEstimateParcel): ShippingEstimateParcel => ({
  length: Math.max(1, Math.round(normalizePositiveNumber(parcel.length, 1))),
  width: Math.max(1, Math.round(normalizePositiveNumber(parcel.width, 1))),
  height: Math.max(1, Math.round(normalizePositiveNumber(parcel.height, 1))),
  weight: Math.max(1, Math.round(normalizePositiveNumber(parcel.weight, 1)))
});

const normalizeCity = (city?: string) =>
  city
    ?.toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
    .trim() ?? '';

export const estimateShippingCost = (input: ShippingEstimateInput): ShippingEstimateResult => {
  const config = getProviderConfig(input.provider);
  const parcels = input.parcels.length > 0 ? input.parcels.map(normalizeParcel) : [];
  const safeParcels =
    parcels.length > 0
      ? parcels
      : [
          {
            length: 30,
            width: 20,
            height: 15,
            weight: 500
          }
        ];

  const actualWeightGrams = safeParcels.reduce((sum, parcel) => sum + parcel.weight, 0);
  const volumetricWeightGrams = safeParcels.reduce((sum, parcel) => {
    const parcelVolumeCm3 = parcel.length * parcel.width * parcel.height;
    const parcelVolumetricKg = parcelVolumeCm3 / config.volumetricDivisor;
    return sum + Math.round(parcelVolumetricKg * 1000);
  }, 0);

  const billedWeightGrams = Math.max(actualWeightGrams, volumetricWeightGrams, 500);
  const billedWeightKg = billedWeightGrams / 1000;
  const actualWeightKg = actualWeightGrams / 1000;
  const volumetricWeightKg = volumetricWeightGrams / 1000;

  let estimatedCostCents = config.baseCents + Math.ceil(billedWeightKg) * config.perKgCents;

  const hasOversizeParcel = safeParcels.some((parcel) =>
    Math.max(parcel.length, parcel.width, parcel.height) > config.oversizeCm
  );
  if (hasOversizeParcel) {
    estimatedCostCents += config.oversizeSurchargeCents;
  }

  const destinationCity = normalizeCity(input.destinationCity);
  const localCity = getLocalCity();
  const distanceMultiplier =
    destinationCity && destinationCity.includes(localCity)
      ? config.localMultiplier
      : config.remoteMultiplier;

  estimatedCostCents = Math.round(estimatedCostCents * distanceMultiplier);
  estimatedCostCents = Math.max(config.minCents, estimatedCostCents);

  return {
    provider: input.provider,
    estimatedCostCents,
    currency: 'RUB',
    billedWeightKg: Number(billedWeightKg.toFixed(2)),
    actualWeightKg: Number(actualWeightKg.toFixed(2)),
    volumetricWeightKg: Number(volumetricWeightKg.toFixed(2))
  };
};
