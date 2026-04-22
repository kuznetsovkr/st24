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
import { STORE_EMAIL_HREF, TELEGRAM_LINK, STORE_EMAIL } from '../constants/contacts.ts';
import { formatPhone } from '../utils/formatPhone.ts';
import { buildShippingPackingDebug } from '../utils/parcelPacking.ts';
import { formatPrice } from '../utils/formatPrice.ts';
import { usePageSeo } from '../utils/usePageSeo.ts';

const CDEK_WIDGET_SCRIPT_ID = 'cdek-widget-script';
const CDEK_WIDGET_SCRIPT_SRC = 'https://cdn.jsdelivr.net/npm/@cdek-it/widget@3';
const CDEK_WIDGET_ROOT_ID = 'checkout-cdek-map';
const DEFAULT_CDEK_FROM = 'Красноярск, улица Калинина, 53а/1';
const DEFAULT_CDEK_LOCATION = 'Красноярск';


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
  cdek: 'СДЭК',
  dellin: 'Деловые линии',
  russian_post: 'Почта России'
};

const DEFAULT_DELIVERY_PROVIDERS: DeliveryProviderSetting[] = [
  {
    key: 'cdek',
    name: 'СДЭК',
    isEnabled: true,
    sortOrder: 0,
    createdAt: '',
    updatedAt: ''
  },
  {
    key: 'dellin',
    name: 'Деловые линии',
    isEnabled: false,
    sortOrder: 1,
    createdAt: '',
    updatedAt: ''
  },
  {
    key: 'russian_post',
    name: 'Почта России',
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
  return office.name || addressLine || 'ПВЗ СДЭК';
};

const CheckoutPage = () => {
  usePageSeo('Оформление заказа | СТ-24', 'Страница оформления заказа интернет-магазина СТ-24.', {
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
        ? 'после выбора ПВЗ'
        : formatPrice(deliveryCostCents)
      : deliveryCostCents === null
      ? 'после выбора ПВЗ'
      : `≈ ${formatPrice(deliveryCostCents)}`;
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
        setError('Не удалось загрузить виджет СДЭК. Обновите страницу и попробуйте снова.');
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
    cdekDefaultLocation,
    shippingParcels
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
      setPickupOptionsError('Введите минимум 2 символа для поиска ПВЗ.');
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
        setPickupOptionsError('Пункты выдачи не найдены. Уточните город или адрес.');
      }
    } catch (searchError) {
      if (searchError instanceof Error) {
        setPickupOptionsError(searchError.message);
      } else {
        setPickupOptionsError('Не удалось загрузить пункты выдачи.');
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
        setPickupOptionsError('Не удалось рассчитать ориентировочную стоимость доставки.');
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
      setError('Корзина пуста. Добавьте товары для продолжения.');
      return;
    }

    if (!hasEnabledDeliveryProviders) {
      setError('Способы доставки временно недоступны. Попробуйте позже.');
      return;
    }

    if (!fullName.trim() || !phone.trim() || !email.trim()) {
      setError('Заполните ФИО, телефон и email.');
      return;
    }

    if (!pickupPoint) {
      setError('Выберите пункт выдачи.');
      return;
    }

    if (!pickupPointCode) {
      setError('Отсутствует код пункта выдачи. Выберите пункт снова.');
      return;
    }

    if (deliveryProvider === 'cdek' && deliveryCostCents === null) {
      setError('Не удалось рассчитать доставку CDEK. Выберите пункт выдачи снова.');
      return;
    }

    if (!deliveryQuoteToken) {
      setError('Срок действия стоимости доставки истек. Выберите пункт выдачи снова.');
      return;
    }

    if (!agreed) {
      setError('Подтвердите согласие с условиями и политикой конфиденциальности.');
      return;
    }

    setIsSubmitting(true);
    try {
      const latest = await syncWithServer();
      const hasIssues = latest.some(
        (item) => typeof item.stock === 'number' && item.quantity > item.stock
      );
      if (hasIssues) {
        setError('Некоторых товаров недостаточно на складе в выбранном количестве. Проверьте корзину.');
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
        deliveryTariffCode:
          deliveryProvider === 'cdek' ? deliveryTariffCode ?? undefined : undefined,
        destinationCode: deliveryProvider === 'cdek' ? undefined : pickupPointCode,
        destinationCity: deliveryProvider === 'cdek' ? undefined : pickupPointCity,
        destinationAddress: deliveryProvider === 'cdek' ? undefined : pickupPointAddress
      });

      const paymentSession = await createOrderPayment(order.id);
      if (paymentSession.alreadyPaid || paymentSession.order.status === 'paid') {
        navigate(`/order-success/${order.id}`);
        return;
      }

      if (paymentSession.confirmationUrl) {
        window.location.href = paymentSession.confirmationUrl;
        return;
      }

      navigate(`/payment/${order.id}`);
    } catch (submitError) {
      if (submitError instanceof Error) {
        setError(submitError.message);
      } else {
        setError('Не удалось создать заказ.');
      }
    } finally {
      setIsSubmitting(false);
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
        <p className="muted">Проверяем авторизацию...</p>
      </div>
    );
  }

  if (status === 'guest') {
    return (
      <div className="page">
        <header className="page-header">
          <div>
            <p className="eyebrow">Оформление заказа</p>
            <h1>Войдите, чтобы продолжить</h1>
            <p className="muted">Авторизация нужна для создания заказа и оплаты.</p>
          </div>
        </header>
        <div className="card">
          <button className="primary-button" onClick={openAuthModal}>
            Войти по телефону
          </button>
          <Link to="/cart" className="ghost-button">
            Вернуться в корзину
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
            <p className="eyebrow">Оформление заказа</p>
            <h1>Корзина пустая</h1>
            <p className="muted">Добавьте товары в корзину и вернитесь сюда.</p>
          </div>
        </header>
        <div className="card">
          <Link to="/catalog" className="primary-button">
            Перейти в каталог
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">Оформление заказа</p>
          <h1>Контактные данные</h1>
          <p className="muted">Заполните форму и перейдите к оплате.</p>
        </div>
        <Link to="/cart" className="link-button">
          Назад в корзину
        </Link>
      </header>

      <div className="checkout-layout">
        <form id="checkout-form" className="card checkout-form" onSubmit={handleSubmit}>
          <div className="form-grid">
            <label className="field">
              <span>ФИО</span>
              <input
                type="text"
                value={fullName}
                onChange={(event) => setFullName(event.target.value)}
                placeholder="Иванов Иван Иванович"
                required
              />
            </label>
            <label className="field">
              <span>Телефон</span>
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
                  <p className="eyebrow">Способы доставки временно недоступны</p>
                  <p className="muted">
                    Администратор отключил все службы доставки. Повторите попытку позже.
                  </p>
                </>
              ) : deliveryProvider === 'cdek' ? (
                <>
                  <p className="muted">
                    Выберите удобный ПВЗ на карте СДЭК. Стоимость доставки рассчитается
                    автоматически.
                  </p>
                </>
              ) : (
                <>
                  <p className="muted">
                    Введите город или адрес и выберите подходящий пункт выдачи из списка.
                  </p>
                </>
              )}

              {hasEnabledDeliveryProviders && pickupPoint ? (
                <>
                  <p className="chip">Выбрано: {pickupPoint}</p>
                  <p className="cdek-meta">
                    {deliveryProvider === 'cdek' && deliveryTariffName
                      ? `${deliveryTariffName} - `
                      : ''}
                    Доставка: {deliveryLabel}
                  </p>
                  {showDeliveryDisclaimer ? (
                  <p className="muted">
                    Стоимость является приблизительной, итоговую стоимость можете уточнить у
                    менеджера в&nbsp;
                    <a href={TELEGRAM_LINK} target="_blank" rel="noreferrer">
                      телеграмме
                    </a>{' '}
                    или на почте{' '}
                    <a href={STORE_EMAIL_HREF}>{STORE_EMAIL}</a>{' '}
                    после отправки.
                  </p>
                  ) : null}
                  {isEstimatingDelivery ? (
                    <p className="muted">Считаем ориентировочную стоимость доставки...</p>
                  ) : null}
                </>
              ) : hasEnabledDeliveryProviders ? (
                <p className="muted">Пункт выдачи не выбран.</p>
              ) : null}
            </div>

            {!hasEnabledDeliveryProviders ? null : deliveryProvider === 'cdek' ? (
              <>
                <div id={CDEK_WIDGET_ROOT_ID} className="cdek-widget-inline" />
                {isWidgetLoading ? <p className="muted">Загружаем карту СДЭК...</p> : null}
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
                    placeholder="Введите город или адрес"
                  />
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={handlePickupPointSearch}
                    disabled={isPickupOptionsLoading}
                  >
                    {isPickupOptionsLoading ? 'Ищем...' : 'Найти ПВЗ'}
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

          <label className="checkbox-field">
            <input
              type="checkbox"
              checked={agreed}
              onChange={(event) => setAgreed(event.target.checked)}
            />
            <span>
              Согласен с <Link to="/terms">условиями оферты</Link> и{' '}
              <Link to="/privacy">политикой обработки персональных данных</Link>.
            </span>
          </label>
          {error && <p className="status-text status-text--error">{error}</p>}
        </form>

        <aside className="card checkout-summary">
          <h3>Ваш заказ ({totalCount})</h3>
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
              <span>Товары:</span>{' '}
              <span className="checkout-summary-value">{formatPrice(totalPriceCents)}</span>
            </p>
            <p className="muted checkout-summary-row">
              <span>Доставка:</span>{' '}
              <span className={deliveryCostCents === null ? undefined : 'checkout-summary-value'}>
                {deliveryLabel}
              </span>
            </p>
            <p className="price">Сумма: {formatPrice(grandTotalCents)}</p>
          </div>
          <button
            form="checkout-form"
            className="primary-button"
            type="submit"
            disabled={isSubmitting}
          >
            {isSubmitting ? 'Создаём заказ...' : 'Перейти к оплате'}
          </button>
        </aside>
      </div>
    </div>
  );
};

export default CheckoutPage;
