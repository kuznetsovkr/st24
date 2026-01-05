import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { fetchOrder } from '../api.ts';
import type { Order } from '../api.ts';
import { useAuth } from '../context/AuthContext.tsx';
import { useUI } from '../context/UIContext.tsx';

const OrderSuccessPage = () => {
  const { orderId } = useParams<{ orderId: string }>();
  const { status } = useAuth();
  const { openAuthModal } = useUI();
  const [order, setOrder] = useState<Order | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
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
            <p className="eyebrow">Заказ</p>
            <h1>Войдите, чтобы увидеть заказ</h1>
            <p className="muted">После авторизации мы покажем информацию о заказе.</p>
          </div>
        </header>
        <div className="card">
          <button className="primary-button" onClick={openAuthModal}>
            Войти по телефону
          </button>
          <Link to="/catalog" className="ghost-button">
            В каталог
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
            <p className="eyebrow">Заказ</p>
            <h1>Не удалось найти заказ</h1>
            <p className="muted">Проверьте ссылку и попробуйте снова.</p>
          </div>
        </header>
        <div className="card">
          <Link to="/catalog" className="primary-button">
            Вернуться в каталог
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
          <p className="eyebrow">Спасибо за заказ</p>
          <h1>Заказ №{order.orderNumber} оформлен</h1>
          <p className="muted">Мы свяжемся с вами, когда заказ будет готов.</p>
        </div>
      </header>
      <div className="card">
        <p className="muted">
          Статус оплаты: <strong>{order.status}</strong>
        </p>
        <div className="button-row">
          <Link to="/account" className="primary-button">
            Перейти в профиль
          </Link>
          <Link to="/catalog" className="ghost-button">
            В каталог
          </Link>
        </div>
      </div>
    </div>
  );
};

export default OrderSuccessPage;
