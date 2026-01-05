import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { fetchOrder, payOrder } from '../api.ts';
import type { Order } from '../api.ts';
import { useAuth } from '../context/AuthContext.tsx';
import { useCart } from '../context/CartContext.tsx';
import { useUI } from '../context/UIContext.tsx';
import { formatPrice } from '../utils/formatPrice.ts';

const PaymentPage = () => {
  const { orderId } = useParams<{ orderId: string }>();
  const navigate = useNavigate();
  const { status } = useAuth();
  const { clear } = useCart();
  const { openAuthModal } = useUI();
  const [order, setOrder] = useState<Order | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [isPaying, setIsPaying] = useState(false);
  const promptedRef = useRef(false);

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
      const updated = await payOrder(orderId);
      setOrder(updated);
      clear();
      navigate(`/order-success/${orderId}`);
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
          <h1>Онлайн-касса (демо)</h1>
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
          <p className="price">{formatPrice(order.totalCents)}</p>
          <p className="muted">
            Имитация оплаты: нажмите кнопку, чтобы завершить заказ.
          </p>
          {error && <p className="status-text status-text--error">{error}</p>}
          <button
            className="primary-button"
            onClick={handlePay}
            disabled={isPaying || order.status === 'paid'}
          >
            {order.status === 'paid'
              ? 'Заказ уже оплачен'
              : isPaying
              ? 'Оплачиваем...'
              : 'Оплачено'}
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
