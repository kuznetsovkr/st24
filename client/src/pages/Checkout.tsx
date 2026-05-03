import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  API_BASE,
  createOrder,
  createOrderPayment,
  estimateShipping,
  fetchBoxTypes,
  fetchDeliveryProviders,
  searchDellinPickupPoints,
  searchRussianPostPickupPoints,
  type BoxType,
  type DeliveryProviderSetting,
  type PickupPointOption
} from '../api.ts';
import { useAuth } from '../context/AuthContext.tsx';
import { useCart } from '../context/CartContext.tsx';
import { useUI } from '../context/UIContext.tsx';
import PrivacyConsentText from '../components/PrivacyConsentText.tsx';
import { STORE_EMAIL_HREF, TELEGRAM_LINK, STORE_EMAIL } from '../constants/contacts.ts';
import { formatPhone } from '../utils/formatPhone.ts';
import { buildShippingPackingDebug } from '../utils/parcelPacking.ts';
import { formatPrice } from '../utils/formatPrice.ts';
import { usePageSeo } from '../utils/usePageSeo.ts';

const CDEK_WIDGET_SCRIPT_ID = 'cdek-widget-script';
const CDEK_WIDGET_SCRIPT_SRC = 'https://cdn.jsdelivr.net/npm/@cdek-it/widget@3';
const CDEK_WIDGET_ROOT_ID = 'checkout-cdek-map';
const DEFAULT_CDEK_FROM = 'РљСЂР°СЃРЅРѕСЏСЂСЃРє, СѓР»РёС†Р° РљР°Р»РёРЅРёРЅР°, 53Р°/1';
const DEFAULT_CDEK_LOCATION = 'РљСЂР°СЃРЅРѕСЏСЂСЃРє';


const getPickupSearchDefault = (provider: DeliveryProvider, cdekDefaultLocation: string) =>
  provider === 'cdek' ? cdekDefaultLocation : '';

type CdekWidgetTariff = {
  tariff_code: number;
  tariff_name: string;
  delivery_sum: number;
  quote_token?: string;
};

type CdekWidgetOffice = {
  code?: string;
  name?: string;
  city?: string;
  address?: string;
};

type CdekFromLocation = string | { code: number };

type CdekWidgetParcel = {
  length: number;
  width: number;
  height: number;
  weight: number;
};

type CdekWidgetInstance = {
  destroy: () => void;
  resetParcels?: () => void;
  addParcel?: (parcels: CdekWidgetParcel | CdekWidgetParcel[]) => void;
};

type CdekWidgetConstructor = new (params: Record<string, unknown>) => CdekWidgetInstance;

declare global {
  interface Window {
    CDEKWidget?: CdekWidgetConstructor;
  }
}

type DeliveryProvider = 'cdek' | 'dellin' | 'russian_post';

const DELIVERY_PROVIDER_LABELS: Record<DeliveryProvider, string> = {
  cdek: 'РЎР”Р­Рљ',
  dellin: 'Р”РµР»РѕРІС‹Рµ Р»РёРЅРёРё',
  russian_post: 'РџРѕС‡С‚Р° Р РѕСЃСЃРёРё'
};

const DEFAULT_DELIVERY_PROVIDERS: DeliveryProviderSetting[] = [
  {
    key: 'cdek',
    name: 'РЎР”Р­Рљ',
    isEnabled: true,
    sortOrder: 0,
    createdAt: '',
    updatedAt: ''
  },
  {
    key: 'dellin',
    name: 'Р”РµР»РѕРІС‹Рµ Р»РёРЅРёРё',
    isEnabled: false,
    sortOrder: 1,
    createdAt: '',
    updatedAt: ''
  },
  {
    key: 'russian_post',
    name: 'РџРѕС‡С‚Р° Р РѕСЃСЃРёРё',
    isEnabled: false,
    sortOrder: 2,
    createdAt: '',
    updatedAt: ''
  }
];

const buildPickupPointLabel = (office: CdekWidgetOffice) => {
  const addressLine = [office.city, office.address].filter(Boolean).join(', ');
  if (office.name && addressLine) {
    return `${office.name}, ${addressLine}`;
  }
  return office.name || addressLine || 'РџР’Р— РЎР”Р­Рљ';
};

const CheckoutPage = () => {
  usePageSeo('РћС„РѕСЂРјР»РµРЅРёРµ Р·Р°РєР°Р·Р° | РЎРў-24', 'РЎС‚СЂР°РЅРёС†Р° РѕС„РѕСЂРјР»РµРЅРёСЏ Р·Р°РєР°Р·Р° РёРЅС‚РµСЂРЅРµС‚-РјР°РіР°Р·РёРЅР° РЎРў-24.', {
    robots: 'noindex,follow'
  });

  const navigate = useNavigate();
  const { user, status } = useAuth();
  const { items, totalCount, totalPriceCents, syncWithServer } = useCart();
  const { openAuthModal } = useUI();
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [deliveryProvider, setDeliveryProvider] = useState<DeliveryProvider>('cdek');
  const [pickupPoint, setPickupPoint] = useState('');
  const [pickupPointCode, setPickupPointCode] = useState('');
  const [pickupPointCity, setPickupPointCity] = useState('');
  const [pickupPointAddress, setPickupPointAddress] = useState('');
  const [deliveryCostCents, setDeliveryCostCents] = useState<number | null>(null);
  const [deliveryTariffName, setDeliveryTariffName] = useState('');
  const [deliveryTariffCode, setDeliveryTariffCode] = useState<number | null>(null);
  const [deliveryQuoteToken, setDeliveryQuoteToken] = useState('');
  const [pickupSearchQuery, setPickupSearchQuery] = useState(
    getPickupSearchDefault('cdek', DEFAULT_CDEK_LOCATION)
  );
  const [pickupOptions, setPickupOptions] = useState<PickupPointOption[]>([]);
  const [isPickupOptionsLoading, setIsPickupOptionsLoading] = useState(false);
  const [isEstimatingDelivery, setIsEstimatingDelivery] = useState(false);
  const [pickupOptionsError, setPickupOptionsError] = useState<string | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isWidgetLoading, setIsWidgetLoading] = useState(false);
  const [boxTypes, setBoxTypes] = useState<BoxType[]>([]);
  const [deliveryProviders, setDeliveryProviders] = useState<DeliveryProviderSetting[]>(
    DEFAULT_DELIVERY_PROVIDERS
  );
  const [expandedSummaryItemIds, setExpandedSummaryItemIds] = useState<Set<string>>(
    () => new Set()
  );
  const promptedRef = useRef(false);
  const estimateRequestIdRef = useRef(0);
  const widgetRef = useRef<CdekWidgetInstance | null>(null);
  const yandexApiKey = (import.meta.env.VITE_YANDEX_MAPS_API_KEY ?? '').trim();
  const cdekFromLocation =
    (import.meta.env.VITE_CDEK_FROM_LOCATION ?? '').trim() || DEFAULT_CDEK_FROM;
  const cdekFromCodeRaw = (import.meta.env.VITE_CDEK_FROM_CODE ?? '').trim();
  const cdekFrom = useMemo<CdekFromLocation>(() => {
    const cdekFromCode = Number.parseInt(cdekFromCodeRaw, 10);
    return Number.isFinite(cdekFromCode) && cdekFromCode > 0
      ? { code: cdekFromCode }
      : cdekFromLocation;
  }, [cdekFromCodeRaw, cdekFromLocation]);
  const cdekDefaultLocation =
    (import.meta.env.VITE_CDEK_DEFAULT_LOCATION ?? '').trim() || DEFAULT_CDEK_LOCATION;
  const enabledDeliveryProviders = useMemo(
    () =>
      deliveryProviders
        .filter((provider) => provider.isEnabled)
        .map((provider) => provider.key as DeliveryProvider),
    [deliveryProviders]
  );
  const hasEnabledDeliveryProviders = enabledDeliveryProviders.length > 0;
  const packingDebug = useMemo(
    () => buildShippingPackingDebug(items, boxTypes),
    [items, boxTypes]
  );
  const shippingParcels = packingDebug.parcels;
  const deliveryLabel =
    deliveryProvider === 'cdek'
      ? deliveryCostCents === null
        ? 'РїРѕСЃР»Рµ РІС‹Р±РѕСЂР° РџР’Р—'
        : formatPrice(deliveryCostCents)
      : deliveryCostCents === null
      ? 'РїРѕСЃР»Рµ РІС‹Р±РѕСЂР° РџР’Р—'
      : `в‰€ ${formatPrice(deliveryCostCents)}`;
  const showDeliveryDisclaimer = deliveryProvider !== 'cdek' && deliveryCostCents !== null;
  const grandTotalCents =
    totalPriceCents + (deliveryProvider === 'cdek' ? (deliveryCostCents ?? 0) : 0);

  useEffect(() => {
    if (!user) {
      return;
    }
    setFullName(user.fullName ?? '');
    setPhone(formatPhone(user.phone ?? ''));
    setEmail(user.email ?? '');
  }, [user]);

  useEffect(() => {
    let disposed = false;
    fetchBoxTypes()
      .then((items) => {
        if (!disposed) {
          setBoxTypes(items);
        }
      })
      .catch(() => {
        if (!disposed) {
          setBoxTypes([]);
        }
      });
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    fetchDeliveryProviders()
      .then((items) => {
        if (!disposed && items.length > 0) {
          setDeliveryProviders(items);
        }
      })
      .catch(() => {
        if (!disposed) {
          setDeliveryProviders(DEFAULT_DELIVERY_PROVIDERS);
        }
      });
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    if (status === 'guest' && !promptedRef.current) {
      openAuthModal();
      promptedRef.current = true;
    }
  }, [status, openAuthModal]);

  useEffect(() => {
    if (!hasEnabledDeliveryProviders) {
      return;
    }
    if (!enabledDeliveryProviders.includes(deliveryProvider)) {
      setDeliveryProvider(enabledDeliveryProviders[0]);
    }
  }, [deliveryProvider, enabledDeliveryProviders, hasEnabledDeliveryProviders]);

  useEffect(() => {
    estimateRequestIdRef.current += 1;
    setPickupPoint('');
    setPickupPointCode('');
    setPickupPointCity('');
    setPickupPointAddress('');
    setDeliveryTariffName('');
    setDeliveryTariffCode(null);
    setDeliveryQuoteToken('');
    setPickupOptions([]);
    setPickupOptionsError(null);
    setIsEstimatingDelivery(false);
    setError(null);
    setDeliveryCostCents(null);
    setPickupSearchQuery(getPickupSearchDefault(deliveryProvider, cdekDefaultLocation));
  }, [deliveryProvider, cdekDefaultLocation, hasEnabledDeliveryProviders]);

  useEffect(() => {
    if (deliveryProvider !== 'cdek' || !hasEnabledDeliveryProviders) {
      if (widgetRef.current) {
        widgetRef.current.destroy();
        widgetRef.current = null;
      }
      setIsWidgetLoading(false);
      return;
    }

    if (!yandexApiKey) {
      return;
    }

    let disposed = false;
    let script = document.getElementById(CDEK_WIDGET_SCRIPT_ID) as HTMLScriptElement | null;

    const initWidget = () => {
      if (disposed || widgetRef.current || !window.CDEKWidget) {
        return;
      }

      setIsWidgetLoading(true);
      widgetRef.current = new window.CDEKWidget({
        apiKey: yandexApiKey,
        root: CDEK_WIDGET_ROOT_ID,
        servicePath: `${API_BASE}/api/cdek/widget`,
        from: cdekFrom,
        defaultLocation: cdekDefaultLocation,
        popup: false,
        canChoose: true,
        hideDeliveryOptions: {
          door: true,
          office: false
        },
        goods: shippingParcels,
        onReady: () => {
          if (!disposed) {
            setIsWidgetLoading(false);
          }
        },
        onChoose: (
          _mode: unknown,
          tariff: CdekWidgetTariff | null,
          target: CdekWidgetOffice
        ) => {
          estimateRequestIdRef.current += 1;
          setIsEstimatingDelivery(false);
          const label = buildPickupPointLabel(target);
          setPickupPoint(label);
          setPickupPointCode(target.code ?? '');
          setPickupPointCity(target.city ?? '');
          setPickupPointAddress(target.address ?? '');
          setDeliveryTariffName(tariff?.tariff_name ?? '');
          setDeliveryTariffCode(
            tariff && Number.isFinite(tariff.tariff_code)
              ? Math.round(tariff.tariff_code)
              : null
          );
          setDeliveryQuoteToken(typeof tariff?.quote_token === 'string' ? tariff.quote_token : '');
          setDeliveryCostCents(
            tariff && Number.isFinite(tariff.delivery_sum)
              ? Math.round(tariff.delivery_sum * 100)
              : 0
          );
          setError(null);
        }
      });
    };

    const handleScriptLoad = () => {
      initWidget();
    };

    const handleScriptError = () => {
      if (!disposed) {
        setIsWidgetLoading(false);
        setError('РќРµ СѓРґР°Р»РѕСЃСЊ Р·Р°РіСЂСѓР·РёС‚СЊ РІРёРґР¶РµС‚ РЎР”Р­Рљ. РћР±РЅРѕРІРёС‚Рµ СЃС‚СЂР°РЅРёС†Сѓ Рё РїРѕРїСЂРѕР±СѓР№С‚Рµ СЃРЅРѕРІР°.');
      }
    };

    if (window.CDEKWidget) {
      initWidget();
    } else {
      if (!script) {
        script = document.createElement('script');
        script.id = CDEK_WIDGET_SCRIPT_ID;
        script.src = CDEK_WIDGET_SCRIPT_SRC;
        script.async = true;
        script.defer = true;
        document.head.appendChild(script);
      }
      script.addEventListener('load', handleScriptLoad);
      script.addEventListener('error', handleScriptError);
    }

    return () => {
      disposed = true;
      if (script) {
        script.removeEventListener('load', handleScriptLoad);
        script.removeEventListener('error', handleScriptError);
      }
      if (widgetRef.current) {
        widgetRef.current.destroy();
        widgetRef.current = null;
      }
    };
  }, [
    deliveryProvider,
    hasEnabledDeliveryProviders,
    yandexApiKey,
    cdekFrom,
    cdekDefaultLocation
  ]);

  useEffect(() => {
    if (deliveryProvider !== 'cdek' || !hasEnabledDeliveryProviders) {
      return;
    }
    const widget = widgetRef.current;
    if (!widget?.resetParcels || !widget?.addParcel) {
      return;
    }
    widget.resetParcels();
    widget.addParcel(shippingParcels);
  }, [deliveryProvider, hasEnabledDeliveryProviders, shippingParcels]);

  const handleDeliveryProviderChange = (provider: DeliveryProvider) => {
    if (provider === deliveryProvider) {
      return;
    }
    if (!enabledDeliveryProviders.includes(provider)) {
      return;
    }
    setDeliveryProvider(provider);
  };

  const handlePickupPointSearch = async () => {
    if (deliveryProvider === 'cdek') {
      return;
    }

    const query = pickupSearchQuery.trim();
    if (query.length < 2) {
      setPickupOptions([]);
      setPickupOptionsError('Р’РІРµРґРёС‚Рµ РјРёРЅРёРјСѓРј 2 СЃРёРјРІРѕР»Р° РґР»СЏ РїРѕРёСЃРєР° РџР’Р—.');
      return;
    }

    setIsPickupOptionsLoading(true);
    setPickupOptionsError(null);
    setPickupOptions([]);

    try {
      const points =
        deliveryProvider === 'dellin'
          ? await searchDellinPickupPoints(query)
          : await searchRussianPostPickupPoints(query);
      setPickupOptions(points);
      if (points.length === 0) {
        setPickupOptionsError('РџСѓРЅРєС‚С‹ РІС‹РґР°С‡Рё РЅРµ РЅР°Р№РґРµРЅС‹. РЈС‚РѕС‡РЅРёС‚Рµ РіРѕСЂРѕРґ РёР»Рё Р°РґСЂРµСЃ.');
      }
    } catch (searchError) {
      if (searchError instanceof Error) {
        setPickupOptionsError(searchError.message);
      } else {
        setPickupOptionsError('РќРµ СѓРґР°Р»РѕСЃСЊ Р·Р°РіСЂСѓР·РёС‚СЊ РїСѓРЅРєС‚С‹ РІС‹РґР°С‡Рё.');
      }
    } finally {
      setIsPickupOptionsLoading(false);
    }
  };

  const requestNonCdekEstimate = async (point: PickupPointOption) => {
    const requestId = estimateRequestIdRef.current + 1;
    estimateRequestIdRef.current = requestId;
    setIsEstimatingDelivery(true);
    setDeliveryCostCents(null);

    try {
      const estimate = await estimateShipping({
        provider: point.provider,
        parcels: shippingParcels,
        destinationCity: point.city,
        destinationCode: point.code,
        destinationAddress: point.address
      });
      if (estimateRequestIdRef.current !== requestId) {
        return;
      }
      setDeliveryCostCents(estimate.estimatedCostCents);
      setDeliveryQuoteToken(estimate.quoteToken);
    } catch (estimateError) {
      if (estimateRequestIdRef.current !== requestId) {
        return;
      }
      if (estimateError instanceof Error) {
        setPickupOptionsError(estimateError.message);
      } else {
        setPickupOptionsError('РќРµ СѓРґР°Р»РѕСЃСЊ СЂР°СЃСЃС‡РёС‚Р°С‚СЊ РѕСЂРёРµРЅС‚РёСЂРѕРІРѕС‡РЅСѓСЋ СЃС‚РѕРёРјРѕСЃС‚СЊ РґРѕСЃС‚Р°РІРєРё.');
      }
      setDeliveryCostCents(null);
      setDeliveryQuoteToken('');
    } finally {
      if (estimateRequestIdRef.current === requestId) {
        setIsEstimatingDelivery(false);
      }
    }
  };

  const handlePickupPointChoose = async (point: PickupPointOption) => {
    setPickupPoint(point.label);
    setPickupPointCode(point.code);
    setPickupPointCity(point.city);
    setPickupPointAddress(point.address);
    setDeliveryTariffName('');
    setDeliveryTariffCode(null);
    setDeliveryQuoteToken('');
    setPickupOptionsError(null);
    await requestNonCdekEstimate(point);
    setError(null);
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);

    if (!user) {
      openAuthModal();
      return;
    }

    if (items.length === 0) {
      setError('РљРѕСЂР·РёРЅР° РїСѓСЃС‚Р°. Р”РѕР±Р°РІСЊС‚Рµ С‚РѕРІР°СЂС‹ РґР»СЏ РїСЂРѕРґРѕР»Р¶РµРЅРёСЏ.');
      return;
    }

    if (!hasEnabledDeliveryProviders) {
      setError('РЎРїРѕСЃРѕР±С‹ РґРѕСЃС‚Р°РІРєРё РІСЂРµРјРµРЅРЅРѕ РЅРµРґРѕСЃС‚СѓРїРЅС‹. РџРѕРїСЂРѕР±СѓР№С‚Рµ РїРѕР·Р¶Рµ.');
      return;
    }

    if (!fullName.trim() || !phone.trim() || !email.trim()) {
      setError('Р—Р°РїРѕР»РЅРёС‚Рµ Р¤РРћ, С‚РµР»РµС„РѕРЅ Рё email.');
      return;
    }

    if (!pickupPoint) {
      setError('Р’С‹Р±РµСЂРёС‚Рµ РїСѓРЅРєС‚ РІС‹РґР°С‡Рё.');
      return;
    }

    if (!pickupPointCode) {
      setError('РћС‚СЃСѓС‚СЃС‚РІСѓРµС‚ РєРѕРґ РїСѓРЅРєС‚Р° РІС‹РґР°С‡Рё. Р’С‹Р±РµСЂРёС‚Рµ РїСѓРЅРєС‚ СЃРЅРѕРІР°.');
      return;
    }

    if (deliveryProvider === 'cdek' && deliveryCostCents === null) {
      setError('РќРµ СѓРґР°Р»РѕСЃСЊ СЂР°СЃСЃС‡РёС‚Р°С‚СЊ РґРѕСЃС‚Р°РІРєСѓ CDEK. Р’С‹Р±РµСЂРёС‚Рµ РїСѓРЅРєС‚ РІС‹РґР°С‡Рё СЃРЅРѕРІР°.');
      return;
    }

    if (!deliveryQuoteToken) {
      setError('РЎСЂРѕРє РґРµР№СЃС‚РІРёСЏ СЃС‚РѕРёРјРѕСЃС‚Рё РґРѕСЃС‚Р°РІРєРё РёСЃС‚РµРє. Р’С‹Р±РµСЂРёС‚Рµ РїСѓРЅРєС‚ РІС‹РґР°С‡Рё СЃРЅРѕРІР°.');
      return;
    }

    if (!agreed) {
      setError('РџРѕРґС‚РІРµСЂРґРёС‚Рµ СЃРѕРіР»Р°СЃРёРµ СЃ СѓСЃР»РѕРІРёСЏРјРё Рё РїРѕР»РёС‚РёРєРѕР№ РєРѕРЅС„РёРґРµРЅС†РёР°Р»СЊРЅРѕСЃС‚Рё.');
      return;
    }

    setIsSubmitting(true);
    let keepSubmittingState = false;
    try {
      const latest = await syncWithServer();
      const hasIssues = latest.some(
        (item) => typeof item.stock === 'number' && item.quantity > item.stock
      );
      if (hasIssues) {
        setError('РќРµРєРѕС‚РѕСЂС‹С… С‚РѕРІР°СЂРѕРІ РЅРµРґРѕСЃС‚Р°С‚РѕС‡РЅРѕ РЅР° СЃРєР»Р°РґРµ РІ РІС‹Р±СЂР°РЅРЅРѕРј РєРѕР»РёС‡РµСЃС‚РІРµ. РџСЂРѕРІРµСЂСЊС‚Рµ РєРѕСЂР·РёРЅСѓ.');
        return;
      }

      const providerLabel = DELIVERY_PROVIDER_LABELS[deliveryProvider];
      const pickupPointValue = pickupPointCode
        ? `${providerLabel}: ${pickupPoint} (code: ${pickupPointCode})`
        : `${providerLabel}: ${pickupPoint}`;

      const order = await createOrder({
        fullName: fullName.trim(),
        phone: phone.trim(),
        email: email.trim(),
        pickupPoint: pickupPointValue,
        pickupPointCode,
        deliveryProvider,
        deliveryQuoteToken,
        privacyConsent: true,
        deliveryTariffCode:
          deliveryProvider === 'cdek' ? deliveryTariffCode ?? undefined : undefined,
        destinationCode: deliveryProvider === 'cdek' ? undefined : pickupPointCode,
        destinationCity: deliveryProvider === 'cdek' ? undefined : pickupPointCity,
        destinationAddress: deliveryProvider === 'cdek' ? undefined : pickupPointAddress
      });

      const paymentSession = await createOrderPayment(order.id);
      if (paymentSession.alreadyPaid || paymentSession.order.status === 'paid') {
        keepSubmittingState = true;
        navigate(`/order-success/${order.id}`);
        return;
      }

      if (paymentSession.confirmationUrl) {
        keepSubmittingState = true;
        window.location.href = paymentSession.confirmationUrl;
        return;
      }

      keepSubmittingState = true;
      navigate(`/payment/${order.id}`);
    } catch (submitError) {
      if (submitError instanceof Error) {
        setError(submitError.message);
      } else {
        setError('РќРµ СѓРґР°Р»РѕСЃСЊ СЃРѕР·РґР°С‚СЊ Р·Р°РєР°Р·.');
      }
    } finally {
      if (!keepSubmittingState) {
        setIsSubmitting(false);
      }
    }
  };
  const toggleSummaryItemName = (itemId: string) => {
    setExpandedSummaryItemIds((prev) => {
      const next = new Set(prev);
      if (next.has(itemId)) {
        next.delete(itemId);
      } else {
        next.add(itemId);
      }
      return next;
    });
  };

  if (status === 'loading') {
    return (
      <div className="page">
        <p className="muted">РџСЂРѕРІРµСЂСЏРµРј Р°РІС‚РѕСЂРёР·Р°С†РёСЋ...</p>
      </div>
    );
  }

  if (status === 'guest') {
    return (
      <div className="page">
        <header className="page-header">
          <div>
            <p className="eyebrow">РћС„РѕСЂРјР»РµРЅРёРµ Р·Р°РєР°Р·Р°</p>
            <h1>Р’РѕР№РґРёС‚Рµ, С‡С‚РѕР±С‹ РїСЂРѕРґРѕР»Р¶РёС‚СЊ</h1>
            <p className="muted">РђРІС‚РѕСЂРёР·Р°С†РёСЏ РЅСѓР¶РЅР° РґР»СЏ СЃРѕР·РґР°РЅРёСЏ Р·Р°РєР°Р·Р° Рё РѕРїР»Р°С‚С‹.</p>
          </div>
        </header>
        <div className="card">
          <button className="primary-button" onClick={openAuthModal}>
            Р’РѕР№С‚Рё РїРѕ С‚РµР»РµС„РѕРЅСѓ
          </button>
          <Link to="/cart" className="ghost-button">
            Р’РµСЂРЅСѓС‚СЊСЃСЏ РІ РєРѕСЂР·РёРЅСѓ
          </Link>
        </div>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="page">
        <header className="page-header">
          <div>
            <p className="eyebrow">РћС„РѕСЂРјР»РµРЅРёРµ Р·Р°РєР°Р·Р°</p>
            <h1>РљРѕСЂР·РёРЅР° РїСѓСЃС‚Р°СЏ</h1>
            <p className="muted">Р”РѕР±Р°РІСЊС‚Рµ С‚РѕРІР°СЂС‹ РІ РєРѕСЂР·РёРЅСѓ Рё РІРµСЂРЅРёС‚РµСЃСЊ СЃСЋРґР°.</p>
          </div>
        </header>
        <div className="card">
          <Link to="/catalog" className="primary-button">
            РџРµСЂРµР№С‚Рё РІ РєР°С‚Р°Р»РѕРі
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">РћС„РѕСЂРјР»РµРЅРёРµ Р·Р°РєР°Р·Р°</p>
          <h1>РљРѕРЅС‚Р°РєС‚РЅС‹Рµ РґР°РЅРЅС‹Рµ</h1>
          <p className="muted">Р—Р°РїРѕР»РЅРёС‚Рµ С„РѕСЂРјСѓ Рё РїРµСЂРµР№РґРёС‚Рµ Рє РѕРїР»Р°С‚Рµ.</p>
        </div>
        <Link to="/cart" className="link-button">
          РќР°Р·Р°Рґ РІ РєРѕСЂР·РёРЅСѓ
        </Link>
      </header>

      <div className="checkout-layout">
        <form id="checkout-form" className="card checkout-form" onSubmit={handleSubmit}>
          <div className="form-grid">
            <label className="field">
              <span>Р¤РРћ</span>
              <input
                type="text"
                value={fullName}
                onChange={(event) => setFullName(event.target.value)}
                placeholder="РРІР°РЅРѕРІ РРІР°РЅ РРІР°РЅРѕРІРёС‡"
                required
              />
            </label>
            <label className="field">
              <span>РўРµР»РµС„РѕРЅ</span>
              <input
                type="tel"
                value={phone}
                onChange={(event) => setPhone(formatPhone(event.target.value))}
                placeholder="+7"
                required
              />
            </label>
            <label className="field">
              <span>Email</span>
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="mail@example.com"
                required
              />
            </label>
          </div>

          <div className="cdek-placeholder">
            <div className="cdek-placeholder-head">
              <div className="delivery-provider-switch">
                {enabledDeliveryProviders.map((provider) => (
                  <button
                    key={provider}
                    type="button"
                    className={`delivery-provider-link${
                      deliveryProvider === provider ? ' is-active' : ''
                    }`}
                    onClick={() => handleDeliveryProviderChange(provider)}
                  >
                    {DELIVERY_PROVIDER_LABELS[provider]}
                  </button>
                ))}
              </div>

              {!hasEnabledDeliveryProviders ? (
                <>
                  <p className="eyebrow">РЎРїРѕСЃРѕР±С‹ РґРѕСЃС‚Р°РІРєРё РІСЂРµРјРµРЅРЅРѕ РЅРµРґРѕСЃС‚СѓРїРЅС‹</p>
                  <p className="muted">
                    РђРґРјРёРЅРёСЃС‚СЂР°С‚РѕСЂ РѕС‚РєР»СЋС‡РёР» РІСЃРµ СЃР»СѓР¶Р±С‹ РґРѕСЃС‚Р°РІРєРё. РџРѕРІС‚РѕСЂРёС‚Рµ РїРѕРїС‹С‚РєСѓ РїРѕР·Р¶Рµ.
                  </p>
                </>
              ) : deliveryProvider === 'cdek' ? (
                <>
                  <p className="muted">
                    Р’С‹Р±РµСЂРёС‚Рµ СѓРґРѕР±РЅС‹Р№ РџР’Р— РЅР° РєР°СЂС‚Рµ РЎР”Р­Рљ. РЎС‚РѕРёРјРѕСЃС‚СЊ РґРѕСЃС‚Р°РІРєРё СЂР°СЃСЃС‡РёС‚Р°РµС‚СЃСЏ
                    Р°РІС‚РѕРјР°С‚РёС‡РµСЃРєРё.
                  </p>
                </>
              ) : (
                <>
                  <p className="muted">
                    Р’РІРµРґРёС‚Рµ РіРѕСЂРѕРґ РёР»Рё Р°РґСЂРµСЃ Рё РІС‹Р±РµСЂРёС‚Рµ РїРѕРґС…РѕРґСЏС‰РёР№ РїСѓРЅРєС‚ РІС‹РґР°С‡Рё РёР· СЃРїРёСЃРєР°.
                  </p>
                </>
              )}

              {hasEnabledDeliveryProviders && pickupPoint ? (
                <>
                  <p className="chip">Р’С‹Р±СЂР°РЅРѕ: {pickupPoint}</p>
                  <p className="cdek-meta">
                    {deliveryProvider === 'cdek' && deliveryTariffName
                      ? `${deliveryTariffName} - `
                      : ''}
                    Р”РѕСЃС‚Р°РІРєР°: {deliveryLabel}
                  </p>
                  {showDeliveryDisclaimer ? (
                  <p className="muted">
                    РЎС‚РѕРёРјРѕСЃС‚СЊ СЏРІР»СЏРµС‚СЃСЏ РїСЂРёР±Р»РёР·РёС‚РµР»СЊРЅРѕР№, РёС‚РѕРіРѕРІСѓСЋ СЃС‚РѕРёРјРѕСЃС‚СЊ РјРѕР¶РµС‚Рµ СѓС‚РѕС‡РЅРёС‚СЊ Сѓ
                    РјРµРЅРµРґР¶РµСЂР° РІ&nbsp;
                    <a href={TELEGRAM_LINK} target="_blank" rel="noreferrer">
                      С‚РµР»РµРіСЂР°РјРјРµ
                    </a>{' '}
                    РёР»Рё РЅР° РїРѕС‡С‚Рµ{' '}
                    <a href={STORE_EMAIL_HREF}>{STORE_EMAIL}</a>{' '}
                    РїРѕСЃР»Рµ РѕС‚РїСЂР°РІРєРё.
                  </p>
                  ) : null}
                  {isEstimatingDelivery ? (
                    <p className="muted">РЎС‡РёС‚Р°РµРј РѕСЂРёРµРЅС‚РёСЂРѕРІРѕС‡РЅСѓСЋ СЃС‚РѕРёРјРѕСЃС‚СЊ РґРѕСЃС‚Р°РІРєРё...</p>
                  ) : null}
                </>
              ) : hasEnabledDeliveryProviders ? (
                <p className="muted">РџСѓРЅРєС‚ РІС‹РґР°С‡Рё РЅРµ РІС‹Р±СЂР°РЅ.</p>
              ) : null}
            </div>

            {!hasEnabledDeliveryProviders ? null : deliveryProvider === 'cdek' ? (
              <>
                <div id={CDEK_WIDGET_ROOT_ID} className="cdek-widget-inline" />
                {isWidgetLoading ? <p className="muted">Р—Р°РіСЂСѓР¶Р°РµРј РєР°СЂС‚Сѓ РЎР”Р­Рљ...</p> : null}
              </>
            ) : (
              <div className="pickup-search-block">
                <div className="pickup-search-row">
                  <input
                    type="text"
                    value={pickupSearchQuery}
                    onChange={(event) => setPickupSearchQuery(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        void handlePickupPointSearch();
                      }
                    }}
                    placeholder="Р’РІРµРґРёС‚Рµ РіРѕСЂРѕРґ РёР»Рё Р°РґСЂРµСЃ"
                  />
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={handlePickupPointSearch}
                    disabled={isPickupOptionsLoading}
                  >
                    {isPickupOptionsLoading ? 'РС‰РµРј...' : 'РќР°Р№С‚Рё РџР’Р—'}
                  </button>
                </div>
                {pickupOptionsError ? <p className="muted">{pickupOptionsError}</p> : null}
                {pickupOptions.length > 0 ? (
                  <div className="pickup-options-list">
                    {pickupOptions.map((option) => (
                      <button
                        key={`${option.provider}:${option.code}:${option.address}`}
                        type="button"
                        className="pickup-option-button"
                        onClick={() => {
                          void handlePickupPointChoose(option);
                        }}
                      >
                        <span>{option.name}</span>
                        <span className="muted">{option.label}</span>
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            )}
          </div>

          <label className="checkbox-field checkbox-field--legal">
            <input
              type="checkbox"
              checked={agreed}
              onChange={(event) => setAgreed(event.target.checked)}
            />
            <PrivacyConsentText />
          </label>
          {error && <p className="status-text status-text--error">{error}</p>}
        </form>

        <aside className="card checkout-summary">
          <h3>Р’Р°С€ Р·Р°РєР°Р· ({totalCount})</h3>
          <ul className="checkout-summary-list">
            {items.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className={`checkout-summary-item-name${expandedSummaryItemIds.has(item.id) ? ' is-expanded' : ''}`}
                  title={item.name}
                  data-full-name={item.name}
                  onClick={() => toggleSummaryItemName(item.id)}
                >
                  {item.name}
                </button>
                <span className="checkout-summary-item-price">
                  {item.quantity} x {formatPrice(item.priceCents)}
                </span>
              </li>
            ))}
          </ul>
          <div className="checkout-summary-total">
            <p className="muted checkout-summary-row">
              <span>РўРѕРІР°СЂС‹:</span>{' '}
              <span className="checkout-summary-value">{formatPrice(totalPriceCents)}</span>
            </p>
            <p className="muted checkout-summary-row">
              <span>Р”РѕСЃС‚Р°РІРєР°:</span>{' '}
              <span className={deliveryCostCents === null ? undefined : 'checkout-summary-value'}>
                {deliveryLabel}
              </span>
            </p>
            <p className="price">РЎСѓРјРјР°: {formatPrice(grandTotalCents)}</p>
          </div>
          <button
            form="checkout-form"
            className="primary-button"
            type="submit"
            disabled={isSubmitting}
          >
            {isSubmitting ? 'РЎРѕР·РґР°С‘Рј Р·Р°РєР°Р·...' : 'РџРµСЂРµР№С‚Рё Рє РѕРїР»Р°С‚Рµ'}
          </button>
        </aside>
      </div>
    </div>
  );
};

export default CheckoutPage;
