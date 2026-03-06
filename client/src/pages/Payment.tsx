import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { createOrderPayment, fetchOrder, refreshOrderPayment } from '../api.ts';
import type { Order } from '../api.ts';
import { useAuth } from '../context/AuthContext.tsx';
import { useCart } from '../context/CartContext.tsx';
import { useUI } from '../context/UIContext.tsx';
import { formatPrice } from '../utils/formatPrice.ts';

const PaymentPage = () => {
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
  const [paymentAmountCents, setPaymentAmountCents] = useState(100);
  const [isTestPaymentMode, setIsTestPaymentMode] = useState(true);
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
      setIsTestPaymentMode(Boolean(payment.isTestMode));

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
      }
    };

    void refreshStatus();

    return () => {
      active = false;
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
          <h3>{isTestPaymentMode ? 'Тестовая сумма к оплате' : 'Сумма к оплате'}</h3>
          <p className="price">{formatPrice(paymentAmountCents)}</p>
          {isTestPaymentMode ? (
            <p className="muted">Сейчас включен тестовый режим: каждый заказ оплачивается на 1 ₽.</p>
          ) : (
            <p className="muted">Оплата будет проведена на полную сумму заказа.</p>
          )}
          {fromYooKassa && isRefreshingStatus && (
            <p className="muted">Проверяем статус оплаты после возврата из ЮKassa...</p>
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
