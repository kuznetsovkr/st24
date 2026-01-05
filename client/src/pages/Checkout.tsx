import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { createOrder } from '../api.ts';
import { useAuth } from '../context/AuthContext.tsx';
import { useCart } from '../context/CartContext.tsx';
import { useUI } from '../context/UIContext.tsx';
import { formatPhone } from '../utils/formatPhone.ts';
import { formatPrice } from '../utils/formatPrice.ts';

const CheckoutPage = () => {
  const navigate = useNavigate();
  const { user, status } = useAuth();
  const { items, totalCount, totalPriceCents, mergeWithServer, refreshFromServer } = useCart();
  const { openAuthModal } = useUI();
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [pickupPoint, setPickupPoint] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const promptedRef = useRef(false);

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

  const handlePickupSelect = () => {
    setPickupPoint('ПВЗ СДЭК · Демо пункт');
  };

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

    if (!agreed) {
      setError('Нужно согласиться с условиями оферты и политикой.');
      return;
    }

    setIsSubmitting(true);
    try {
      await mergeWithServer();
      const latest = await refreshFromServer();
      const hasIssues = latest.some(
        (item) => typeof item.stock === 'number' && item.quantity > item.stock
      );
      if (hasIssues) {
        setError('Некоторых товаров нет в нужном количестве. Проверьте корзину.');
        return;
      }
      const order = await createOrder({
        fullName: fullName.trim(),
        phone: phone.trim(),
        email: email.trim(),
        pickupPoint
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
            <div>
              <p className="eyebrow">Пункт выдачи СДЭК</p>
              <p className="muted">
                Здесь будет виджет. Пока выберите тестовый пункт выдачи.
              </p>
              {pickupPoint ? (
                <p className="chip">Выбрано: {pickupPoint}</p>
              ) : (
                <p className="muted">Пункт выдачи не выбран.</p>
              )}
            </div>
            <button type="button" className="ghost-button" onClick={handlePickupSelect}>
              {pickupPoint ? 'Изменить пункт' : 'Выбрать пункт'}
            </button>
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
          <h3>Ваш заказ</h3>
          <ul className="checkout-summary-list">
            {items.map((item) => (
              <li key={item.id}>
                <span>{item.name}</span>
                <span>
                  {item.quantity} × {formatPrice(item.priceCents)}
                </span>
              </li>
            ))}
          </ul>
          <div className="checkout-summary-total">
            <p className="muted">Товаров: {totalCount}</p>
            <p className="price">{formatPrice(totalPriceCents)}</p>
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
