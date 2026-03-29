import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { fetchOrder } from '../api.ts';
import type { Order } from '../api.ts';
import { useAuth } from '../context/AuthContext.tsx';
import { useUI } from '../context/UIContext.tsx';
import { usePageSeo } from '../utils/usePageSeo.ts';

const resolvePaymentStatusLabel = (order: Order) => {
  const paymentStatus = (order.paymentStatus ?? '').trim().toLowerCase();
  const orderStatus = (order.status ?? '').trim().toLowerCase();

  if (orderStatus === 'paid' || paymentStatus === 'succeeded') {
    return 'Оплачен';
  }

  if (paymentStatus === 'pending') {
    return 'Ожидает оплаты';
  }

  if (paymentStatus === 'waiting_for_capture') {
    return 'Ожидает подтверждения платежа';
  }

  if (paymentStatus === 'canceled') {
    return 'Оплата отменена';
  }

  if (paymentStatus === 'rejected') {
    return 'Оплата отклонена';
  }

  if (orderStatus === 'pending') {
    return 'Ожидает оплаты';
  }

  if (orderStatus === 'canceled') {
    return 'Заказ отменен';
  }

  const fallback = paymentStatus || orderStatus;
  if (!fallback) {
    return 'Статус уточняется';
  }

  return fallback.replace(/_/g, ' ');
};

const OrderSuccessPage = () => {
  usePageSeo('Статус заказа | СТ-24', 'Страница статуса и подтверждения заказа СТ-24.', {
    robots: 'noindex,follow'
  });

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

  const paymentStatusLabel = resolvePaymentStatusLabel(order);

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">Спасибо за заказ</p>
          <h1>Заказ №{order.orderNumber} оформлен</h1>
        </div>
      </header>
      <div className="card" style={{ border: 'none' }}>
        <div className="need-part-success" role="status" aria-live="polite">
          <div className="need-part-success-icon" aria-hidden="true">
            <svg xmlns="http://www.w3.org/2000/svg" width="17" height="13" viewBox="0 0 17 13" fill="none">
              <path
                className="need-part-success-check"
                d="M16.5 0.5L5.3 12.5L0.5 8"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
          <p className="status-text need-part-success-text">Спасибо за заказ.</p>
        </div>
        <p className="muted"  style={{ textAlign: 'center' }}>
          Статус оплаты: <strong>{paymentStatusLabel}</strong>
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
