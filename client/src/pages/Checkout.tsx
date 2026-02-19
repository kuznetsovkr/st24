import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { API_BASE, createOrder } from '../api.ts';
import { useAuth } from '../context/AuthContext.tsx';
import { useCart } from '../context/CartContext.tsx';
import { useUI } from '../context/UIContext.tsx';
import { formatPhone } from '../utils/formatPhone.ts';
import { buildShippingParcels } from '../utils/parcelPacking.ts';
import { formatPrice } from '../utils/formatPrice.ts';

const CDEK_WIDGET_SCRIPT_ID = 'cdek-widget-script';
const CDEK_WIDGET_SCRIPT_SRC = 'https://cdn.jsdelivr.net/npm/@cdek-it/widget@3';
const CDEK_WIDGET_ROOT_ID = 'checkout-cdek-map';
const DEFAULT_CDEK_FROM = 'Красноярск, улица Калинина, 53а/1';
const DEFAULT_CDEK_LOCATION = 'Красноярск';

type CdekWidgetTariff = {
  tariff_code: number;
  tariff_name: string;
  delivery_sum: number;
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

const buildPickupPointLabel = (office: CdekWidgetOffice) => {
  const addressLine = [office.city, office.address].filter(Boolean).join(', ');
  if (office.name && addressLine) {
    return `${office.name}, ${addressLine}`;
  }
  return office.name || addressLine || 'ПВЗ СДЭК';
};

const CheckoutPage = () => {
  const navigate = useNavigate();
  const { user, status } = useAuth();
  const { items, totalCount, totalPriceCents, syncWithServer } = useCart();
  const { openAuthModal } = useUI();
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [pickupPoint, setPickupPoint] = useState('');
  const [pickupPointCode, setPickupPointCode] = useState('');
  const [deliveryCostCents, setDeliveryCostCents] = useState<number | null>(null);
  const [deliveryTariffName, setDeliveryTariffName] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isWidgetLoading, setIsWidgetLoading] = useState(false);
  const [expandedSummaryItemIds, setExpandedSummaryItemIds] = useState<Set<string>>(
    () => new Set()
  );
  const promptedRef = useRef(false);
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
  const shippingParcels = useMemo<CdekWidgetParcel[]>(
    () => buildShippingParcels(items),
    [items]
  );
  const deliveryLabel =
    deliveryCostCents === null ? 'после выбора ПВЗ' : formatPrice(deliveryCostCents);
  const grandTotalCents = totalPriceCents + (deliveryCostCents ?? 0);

  useEffect(() => {
    if (!user) {
      return;
    }
    setFullName(user.fullName ?? '');
    setPhone(formatPhone(user.phone ?? ''));
    setEmail(user.email ?? '');
  }, [user]);

  useEffect(() => {
    if (status === 'guest' && !promptedRef.current) {
      openAuthModal();
      promptedRef.current = true;
    }
  }, [status, openAuthModal]);

  useEffect(() => {
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
          const label = buildPickupPointLabel(target);
          setPickupPoint(label);
          setPickupPointCode(target.code ?? '');
          setDeliveryTariffName(tariff?.tariff_name ?? '');
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
  }, [yandexApiKey, cdekFrom, cdekDefaultLocation, shippingParcels]);

  useEffect(() => {
    const widget = widgetRef.current;
    if (!widget?.resetParcels || !widget?.addParcel) {
      return;
    }
    widget.resetParcels();
    widget.addParcel(shippingParcels);
  }, [shippingParcels]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);

    if (!user) {
      openAuthModal();
      return;
    }

    if (items.length === 0) {
      setError('Корзина пуста. Добавьте товары, чтобы оформить заказ.');
      return;
    }

    if (!fullName.trim() || !phone.trim() || !email.trim()) {
      setError('Заполните ФИО, телефон и почту.');
      return;
    }

    if (!pickupPoint) {
      setError('Выберите пункт выдачи.');
      return;
    }

    if (deliveryCostCents === null) {
      setError('Не удалось получить стоимость доставки. Выберите пункт выдачи ещё раз.');
      return;
    }

    if (!agreed) {
      setError('Нужно согласиться с условиями оферты и политикой.');
      return;
    }

    setIsSubmitting(true);
    try {
      const latest = await syncWithServer();
      const hasIssues = latest.some(
        (item) => typeof item.stock === 'number' && item.quantity > item.stock
      );
      if (hasIssues) {
        setError('Некоторых товаров нет в нужном количестве. Проверьте корзину.');
        return;
      }

      const pickupPointValue = pickupPointCode
        ? `${pickupPoint} (код: ${pickupPointCode})`
        : pickupPoint;

      const order = await createOrder({
        fullName: fullName.trim(),
        phone: phone.trim(),
        email: email.trim(),
        pickupPoint: pickupPointValue,
        deliveryCostCents
      });
      navigate(`/payment/${order.id}`);
    } catch (submitError) {
      if (submitError instanceof Error) {
        setError(submitError.message);
      } else {
        setError('Не удалось оформить заказ.');
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
        <Link to="/cart" className="ghost-button">
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
              <p className="eyebrow">{'\u041f\u0443\u043d\u043a\u0442 \u0432\u044b\u0434\u0430\u0447\u0438 \u0421\u0414\u042d\u041a'}</p>
              <p className="muted">
                {
                  '\u0412\u044b\u0431\u0435\u0440\u0438\u0442\u0435 \u0443\u0434\u043e\u0431\u043d\u044b\u0439 \u041f\u0412\u0417 \u043d\u0430 \u043a\u0430\u0440\u0442\u0435 \u0421\u0414\u042d\u041a. \u0421\u0442\u043e\u0438\u043c\u043e\u0441\u0442\u044c \u0434\u043e\u0441\u0442\u0430\u0432\u043a\u0438 \u043f\u043e\u0434\u0442\u044f\u043d\u0435\u0442\u0441\u044f \u0430\u0432\u0442\u043e\u043c\u0430\u0442\u0438\u0447\u0435\u0441\u043a\u0438.'
                }
              </p>
              {pickupPoint ? (
                <>
                  <p className="chip">{'\u0412\u044b\u0431\u0440\u0430\u043d\u043e:'} {pickupPoint}</p>
                  <p className="cdek-meta">
                    {deliveryTariffName ? `${deliveryTariffName} \u00b7 ` : ''}
                    {'\u0414\u043e\u0441\u0442\u0430\u0432\u043a\u0430:'} {deliveryLabel}
                  </p>
                </>
              ) : (
                <p className="muted">{'\u041f\u0443\u043d\u043a\u0442 \u0432\u044b\u0434\u0430\u0447\u0438 \u043d\u0435 \u0432\u044b\u0431\u0440\u0430\u043d.'}</p>
              )}
            </div>
            {!yandexApiKey ? (
              <p className="status-text status-text--error">
                {
                  '\u0414\u043e\u0431\u0430\u0432\u044c\u0442\u0435 VITE_YANDEX_MAPS_API_KEY \u0432 client/.env \u0434\u043b\u044f \u0440\u0430\u0431\u043e\u0442\u044b \u0432\u0438\u0434\u0436\u0435\u0442\u0430 \u0421\u0414\u042d\u041a.'
                }
              </p>
            ) : null}
            <div id={CDEK_WIDGET_ROOT_ID} className="cdek-widget-inline" />
            {isWidgetLoading ? <p className="muted">{'\u0417\u0430\u0433\u0440\u0443\u0436\u0430\u0435\u043c \u043a\u0430\u0440\u0442\u0443 \u0421\u0414\u042d\u041a...'}</p> : null}
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
              <span>{'\u0422\u043e\u0432\u0430\u0440\u044b:'}</span>{' '}
              <span className="checkout-summary-value">{formatPrice(totalPriceCents)}</span>
            </p>
            <p className="muted checkout-summary-row">
              <span>{'\u0414\u043e\u0441\u0442\u0430\u0432\u043a\u0430:'}</span>{' '}
              <span className={deliveryCostCents === null ? undefined : 'checkout-summary-value'}>
                {deliveryLabel}
              </span>
            </p>
            <p className="price">{'\u0421\u0443\u043c\u043c\u0430:'} {formatPrice(grandTotalCents)}</p>
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
