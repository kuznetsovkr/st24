import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { createOrderPayment, fetchOrder, refreshOrderPayment } from '../api.ts';
import type { Order } from '../api.ts';
import { useAuth } from '../context/AuthContext.tsx';
import { useCart } from '../context/CartContext.tsx';
import { useUI } from '../context/UIContext.tsx';
import { formatPrice } from '../utils/formatPrice.ts';
import { usePageSeo } from '../utils/usePageSeo.ts';

const PaymentStatusSpinner = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    aria-hidden="true"
    className="payment-status-spinner"
  >
    <path d="m12.5.5v3c0,.276-.224.5-.5.5s-.5-.224-.5-.5V.5c0-.276.224-.5.5-.5s.5.224.5.5Zm-.5,19.5c-.276,0-.5.224-.5.5v3c0,.276.224.5.5.5s.5-.224.5-.5v-3c0-.276-.224-.5-.5-.5ZM4,12c0-.276-.224-.5-.5-.5H.5c-.276,0-.5.224-.5.5s.224.5.5.5h3c.276,0,.5-.224.5-.5Zm19.5-.5h-3c-.276,0-.5.224-.5.5s.224.5.5.5h3c.276,0,.5-.224.5-.5s-.224-.5-.5-.5ZM4.426,15.889l-2.584,1.524c-.238.141-.317.447-.177.685.094.158.26.246.431.246.087,0,.174-.022.254-.069l2.584-1.524c.238-.141.317-.447.177-.685-.142-.239-.447-.316-.685-.177Zm14.895-7.708c.087,0,.174-.022.254-.069l2.584-1.524c.238-.141.317-.447.177-.685-.142-.238-.447-.316-.685-.177l-2.584,1.524c-.238.141-.317.447-.177.685.094.158.26.246.431.246Zm2.838,9.232l-2.584-1.524c-.238-.139-.543-.062-.685.177-.141.237-.062.544.177.685l2.584,1.524c.08.047.167.069.254.069.171,0,.337-.088.431-.246.141-.237.062-.544-.177-.685ZM4.934,7.25l-2.584-1.524c-.237-.14-.544-.062-.685.177-.141.237-.062.544.177.685l2.584,1.524c.08.047.167.069.254.069.171,0,.337-.088.431-.246.141-.237.062-.544-.177-.685Zm1.653-5.408c-.142-.239-.448-.316-.685-.177-.238.141-.317.447-.177.685l1.524,2.584c.094.158.26.246.431.246.087,0,.174-.022.254-.069.238-.141.317-.447.177-.685l-1.524-2.584Zm10.163,17.225c-.142-.239-.447-.316-.685-.177-.238.141-.317.447-.177.685l1.524,2.584c.094.158.26.246.431.246.087,0,.174-.022.254-.069.238-.141.317-.447.177-.685l-1.524-2.584Zm-8.815-.177c-.237-.139-.544-.062-.685.177l-1.524,2.584c-.141.237-.062.544.177.685.08.047.167.069.254.069.171,0,.337-.088.431-.246l1.524-2.584c.141-.237.062-.544-.177-.685ZM18.098,1.665c-.237-.139-.543-.062-.685.177l-1.524,2.584c-.141.237-.062.544.177.685.08.047.167.069.254.069.171,0,.337-.088.431-.246l1.524-2.584c.141-.237.062-.544-.177-.685Z" />
  </svg>
);

const PaymentPage = () => {
  usePageSeo('Оплата заказа | СТ-24', 'Страница оплаты заказа интернет-магазина СТ-24.', {
    robots: 'noindex,follow'
  });

  const { orderId } = useParams<{ orderId: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { status } = useAuth();
  const { clear } = useCart();
  const { openAuthModal } = useUI();
  const [order, setOrder] = useState<Order | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [isPaying, setIsPaying] = useState(false);
  const [isRefreshingStatus, setIsRefreshingStatus] = useState(false);
  const [isStatusPollingActive, setIsStatusPollingActive] = useState(false);
  const [paymentAmountCents, setPaymentAmountCents] = useState(100);
  const promptedRef = useRef(false);
  const fromYooKassa = searchParams.get('fromYooKassa') === '1';

  useEffect(() => {
    if (status === 'guest' && !promptedRef.current) {
      openAuthModal();
      promptedRef.current = true;
    }
  }, [status, openAuthModal]);

  useEffect(() => {
    if (!orderId) {
      setState('error');
      return;
    }

    let active = true;
    setState('loading');

    fetchOrder(orderId)
      .then((data) => {
        if (!active) {
          return;
        }
        setOrder(data);
        setPaymentAmountCents(data.totalCents);
        setState('ready');
      })
      .catch(() => {
        if (active) {
          setState('error');
        }
      });

    return () => {
      active = false;
    };
  }, [orderId]);

  const handlePay = async () => {
    if (!orderId) {
      return;
    }
    setError(null);
    setIsPaying(true);
    try {
      const payment = await createOrderPayment(orderId);
      setOrder(payment.order);
      if (typeof payment.amountCents === 'number' && payment.amountCents > 0) {
        setPaymentAmountCents(payment.amountCents);
      }

      if (payment.alreadyPaid || payment.order.status === 'paid') {
        clear();
        navigate(`/order-success/${orderId}`);
        return;
      }

      if (!payment.confirmationUrl) {
        throw new Error('Не удалось получить ссылку на оплату');
      }
      window.location.href = payment.confirmationUrl;
    } catch (payError) {
      if (payError instanceof Error) {
        setError(payError.message);
      } else {
        setError('Не удалось оплатить заказ.');
      }
    } finally {
      setIsPaying(false);
    }
  };

  useEffect(() => {
    if (!fromYooKassa || !orderId || status !== 'auth') {
      return;
    }

    let active = true;
    let timeoutId: number | undefined;
    let attempts = 0;
    const maxAttempts = 10;
    setIsStatusPollingActive(true);

    const refreshStatus = async () => {
      if (!active) {
        return;
      }

      setIsRefreshingStatus(true);
      try {
        const data = await refreshOrderPayment(orderId);
        if (!active) {
          return;
        }
        setOrder(data.order);

        if (data.order.status === 'paid') {
          setIsStatusPollingActive(false);
          clear();
          navigate(`/order-success/${orderId}`, { replace: true });
          return;
        }
      } catch (refreshError) {
        if (!active) {
          return;
        }
        if (refreshError instanceof Error) {
          setError(refreshError.message);
        } else {
          setError('Не удалось проверить статус оплаты.');
        }
      } finally {
        if (active) {
          setIsRefreshingStatus(false);
        }
      }

      attempts += 1;
      if (active && attempts < maxAttempts) {
        timeoutId = window.setTimeout(refreshStatus, 2500);
      } else if (active) {
        setIsStatusPollingActive(false);
      }
    };

    void refreshStatus();

    return () => {
      active = false;
      setIsStatusPollingActive(false);
      if (timeoutId) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [fromYooKassa, orderId, status, clear, navigate]);

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
            <p className="eyebrow">Оплата</p>
            <h1>Войдите, чтобы оплатить</h1>
            <p className="muted">Авторизуйтесь по телефону и вернитесь к оплате.</p>
          </div>
        </header>
        <div className="card">
          <button className="primary-button" onClick={openAuthModal}>
            Войти по телефону
          </button>
          <Link to="/cart" className="ghost-button">
            В корзину
          </Link>
        </div>
      </div>
    );
  }

  if (state === 'error') {
    return (
      <div className="page">
        <header className="page-header">
          <div>
            <p className="eyebrow">Оплата</p>
            <h1>Не удалось загрузить заказ</h1>
            <p className="muted">Проверьте ссылку и попробуйте снова.</p>
          </div>
        </header>
        <div className="card">
          <Link to="/cart" className="primary-button">
            Вернуться в корзину
          </Link>
        </div>
      </div>
    );
  }

  if (state === 'loading' || !order) {
    return (
      <div className="page">
        <p className="muted">Загружаем заказ...</p>
      </div>
    );
  }

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">Оплата</p>
          <h1>Онлайн-оплата (ЮKassa)</h1>
          <p className="muted">
            Заказ №{order.orderNumber} · статус: {order.status}
          </p>
        </div>
        <Link to="/cart" className="ghost-button">
          В корзину
        </Link>
      </header>
      <div className="payment-layout">
        <div className="card payment-card">
          <h3>Сумма к оплате</h3>
          <p className="price">{formatPrice(paymentAmountCents)}</p>
          <p className="muted">Оплата будет проведена на полную сумму заказа.</p>
          {fromYooKassa && isStatusPollingActive && (
            <p className="muted payment-status-checking">
              <PaymentStatusSpinner />
              <span>Проверяем статус оплаты после возврата из ЮKassa...</span>
            </p>
          )}
          {error && <p className="status-text status-text--error">{error}</p>}
          <button
            className="primary-button"
            onClick={handlePay}
            disabled={isPaying || isRefreshingStatus || order.status === 'paid'}
          >
            {order.status === 'paid'
              ? 'Заказ уже оплачен'
              : isPaying
              ? 'Переходим в ЮKassa...'
              : 'Оплатить в ЮKassa'}
          </button>
          {order.status === 'paid' && (
            <Link to={`/order-success/${order.id}`} className="ghost-button">
              Перейти к благодарности
            </Link>
          )}
        </div>
      </div>
    </div>
  );
};

export default PaymentPage;
