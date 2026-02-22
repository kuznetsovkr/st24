import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  fetchOrderItems,
  fetchOrders,
  requestProfileEmailCode,
  requestProfilePhoneCode,
  updateProfile,
  verifyProfileEmailCode,
  verifyProfilePhoneCode
} from '../api.ts';
import type { Order, OrderItem } from '../api.ts';
import { useAuth } from '../context/AuthContext.tsx';
import { useCart } from '../context/CartContext.tsx';
import { useUI } from '../context/UIContext.tsx';
import { formatPrice } from '../utils/formatPrice.ts';
import { formatPhone } from '../utils/formatPhone.ts';

const ProfileIcon = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    width="16"
    height="16"
    fill="currentColor"
    aria-hidden="true"
  >
    <path d="m17,11c0-2.757-2.243-5-5-5s-5,2.243-5,5,2.243,5,5,5,5-2.243,5-5Zm-9,0c0-2.206,1.794-4,4-4s4,1.794,4,4-1.794,4-4,4-4-1.794-4-4Zm11,11v2h-1v-2c0-1.654-1.346-3-3-3h-6c-1.654,0-3,1.346-3,3v2h-1v-2c0-2.206,1.794-4,4-4h6c2.206,0,4,1.794,4,4Zm3.362-6.796l-2.152,3.385-2.651-1.686.537-.844,1.808,1.149,1.066-1.678-1.77-1.071.167-.398c.42-.999.633-2.029.633-3.061s-.211-2.055-.626-3.051l-.165-.395,1.763-1.082-1.068-1.681-1.738,1.105-.283-.307c-1.193-1.294-2.739-2.141-4.47-2.45l-.412-.073V1h-2v2.066l-.412.073c-1.73.309-3.276,1.156-4.47,2.45l-.283.307-1.738-1.105-1.068,1.681,1.763,1.082-.165.395c-.415.996-.626,2.023-.626,3.051s.213,2.062.633,3.061l.167.398-1.77,1.071,1.062,1.67,1.768-1.175.553.833-2.617,1.739-2.157-3.394,1.914-1.159c-.366-.996-.552-2.019-.552-3.045s.184-2.043.547-3.036l-1.907-1.17,2.15-3.383,1.885,1.199c1.189-1.172,2.699-2,4.325-2.371V0h4v2.239c1.626.371,3.136,1.199,4.325,2.371l1.885-1.199,2.15,3.383-1.907,1.17c.363.993.547,2.013.547,3.036s-.186,2.049-.552,3.045l1.914,1.159Z" />
  </svg>
);

const LogoutIcon = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    width="16"
    height="16"
    fill="currentColor"
    aria-hidden="true"
  >
    <path d="M8,23.5c0,.276-.224,.5-.5,.5H3.5c-1.93,0-3.5-1.57-3.5-3.5V3.5C0,1.57,1.57,0,3.5,0H7.5c.276,0,.5,.224,.5,.5s-.224,.5-.5,.5H3.5c-1.378,0-2.5,1.121-2.5,2.5V20.5c0,1.379,1.122,2.5,2.5,2.5H7.5c.276,0,.5,.224,.5,.5Zm16-11.5s0,0,0,0c0-.473-.184-.918-.52-1.253l-4.628-4.601c-.196-.193-.512-.193-.707,.002-.195,.196-.194,.513,.002,.707,0,0,4.645,4.631,4.658,4.646H5.5c-.276,0-.5,.224-.5,.5s.224,.5,.5,.5H22.803c-.011,.013-4.656,4.646-4.656,4.646-.196,.194-.197,.512-.002,.707,.098,.099,.226,.147,.354,.147,.127,0,.255-.049,.353-.146l4.628-4.604c.335-.334,.518-.777,.519-1.249,0,0,0,0,0,0,0,0,0,0,0,0Z" />
  </svg>
);

const AccountPage = () => {
  const navigate = useNavigate();
  const { user, status, setUser, logout } = useAuth();
  const { clear } = useCart();
  const { openAuthModal } = useUI();
  const [isEditing, setIsEditing] = useState(false);
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [phoneCode, setPhoneCode] = useState('');
  const [phoneResendCooldown, setPhoneResendCooldown] = useState(0);
  const [phoneVerificationState, setPhoneVerificationState] = useState<
    'verified' | 'idle' | 'code-sent'
  >('verified');
  const [phoneVerificationMessage, setPhoneVerificationMessage] = useState<string | null>(null);
  const [phoneVerificationError, setPhoneVerificationError] = useState<string | null>(null);
  const [isRequestingCode, setIsRequestingCode] = useState(false);
  const [isVerifyingPhone, setIsVerifyingPhone] = useState(false);
  const [emailCode, setEmailCode] = useState('');
  const [emailVerificationState, setEmailVerificationState] = useState<
    'verified' | 'idle' | 'code-sent'
  >('verified');
  const [emailVerificationMessage, setEmailVerificationMessage] = useState<string | null>(null);
  const [emailVerificationError, setEmailVerificationError] = useState<string | null>(null);
  const [isRequestingEmailCode, setIsRequestingEmailCode] = useState(false);
  const [isVerifyingEmail, setIsVerifyingEmail] = useState(false);
  const [emailResendCooldown, setEmailResendCooldown] = useState(0);
  const [orders, setOrders] = useState<Order[]>([]);
  const [ordersState, setOrdersState] = useState<'idle' | 'loading' | 'ready' | 'error'>(
    'idle'
  );
  const [ordersError, setOrdersError] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [detailsOrder, setDetailsOrder] = useState<Order | null>(null);
  const [detailsItems, setDetailsItems] = useState<OrderItem[]>([]);
  const [detailsState, setDetailsState] = useState<'idle' | 'loading' | 'ready' | 'error'>(
    'idle'
  );
  const [detailsError, setDetailsError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) {
      return;
    }
    setFullName(user.fullName ?? '');
    setPhone(formatPhone(user.phone ?? ''));
    setEmail(user.email ?? '');
    setPhoneCode('');
    setPhoneResendCooldown(0);
    setPhoneVerificationState('verified');
    setPhoneVerificationMessage(null);
    setPhoneVerificationError(null);
    setEmailCode('');
    setEmailResendCooldown(0);
    setEmailVerificationState('verified');
    setEmailVerificationMessage(null);
    setEmailVerificationError(null);
  }, [user]);

  useEffect(() => {
    if (phoneResendCooldown <= 0) {
      return;
    }

    const timer = window.setInterval(() => {
      setPhoneResendCooldown((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);

    return () => {
      window.clearInterval(timer);
    };
  }, [phoneResendCooldown]);

  useEffect(() => {
    if (emailResendCooldown <= 0) {
      return;
    }

    const timer = window.setInterval(() => {
      setEmailResendCooldown((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);

    return () => {
      window.clearInterval(timer);
    };
  }, [emailResendCooldown]);

  useEffect(() => {
    if (status !== 'auth') {
      setOrders([]);
      setOrdersState('idle');
      setOrdersError(null);
      return;
    }

    let active = true;
    setOrdersState('loading');
    setOrdersError(null);

    fetchOrders()
      .then((items) => {
        if (!active) {
          return;
        }
        setOrders(items);
        setOrdersState('ready');
      })
      .catch((loadError) => {
        if (!active) {
          return;
        }
        setOrdersError(
          loadError instanceof Error ? loadError.message : 'Не удалось загрузить заказы.'
        );
        setOrdersState('error');
      });

    return () => {
      active = false;
    };
  }, [status]);

  const normalizedPhone = phone.replace(/\D/g, '');
  const originalPhone = user?.phone ?? '';
  const isPhoneChanged = Boolean(originalPhone) && normalizedPhone !== originalPhone;
  const phoneNeedsVerification = isEditing && isPhoneChanged && phoneVerificationState !== 'verified';
  const normalizedEmail = email.trim().toLowerCase();
  const originalEmail = (user?.email ?? '').trim().toLowerCase();
  const isEmailChanged = normalizedEmail !== originalEmail;
  const emailNeedsVerification =
    isEditing && normalizedEmail !== '' && isEmailChanged && emailVerificationState !== 'verified';

  const handleEdit = () => {
    setMessage(null);
    setError(null);
    setPhoneVerificationMessage(null);
    setPhoneVerificationError(null);
    setEmailVerificationMessage(null);
    setEmailVerificationError(null);
    setIsEditing(true);
  };

  const handleCancel = () => {
    if (user) {
      setFullName(user.fullName ?? '');
      setPhone(formatPhone(user.phone ?? ''));
      setEmail(user.email ?? '');
    }
    setMessage(null);
    setError(null);
    setPhoneCode('');
    setPhoneResendCooldown(0);
    setPhoneVerificationState('verified');
    setPhoneVerificationMessage(null);
    setPhoneVerificationError(null);
    setEmailCode('');
    setEmailResendCooldown(0);
    setEmailVerificationState('verified');
    setEmailVerificationMessage(null);
    setEmailVerificationError(null);
    setIsEditing(false);
  };

  const handleSave = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!isEditing) {
      return;
    }
    setMessage(null);
    setError(null);
    setIsSaving(true);
    try {
      const updated = await updateProfile({
        fullName: fullName.trim(),
        phone: phone.trim(),
        email: email.trim()
      });
      setUser(updated);
      setIsEditing(false);
      setMessage('Профиль обновлен.');
    } catch (saveError) {
      if (saveError instanceof Error) {
        setError(saveError.message);
      } else {
        setError('Не удалось сохранить профиль.');
      }
    } finally {
      setIsSaving(false);
    }
  };

  const handlePhoneChange = (value: string) => {
    const formatted = formatPhone(value);
    setPhone(formatted);
    setPhoneCode('');
    setPhoneResendCooldown(0);
    setPhoneVerificationMessage(null);
    setPhoneVerificationError(null);

    if (!user) {
      return;
    }

    const digits = formatted.replace(/\D/g, '');
    if (digits === user.phone) {
      setPhoneVerificationState('verified');
    } else {
      setPhoneVerificationState('idle');
    }
  };

  const handleRequestPhoneCode = async () => {
    setPhoneVerificationMessage(null);
    setPhoneVerificationError(null);
    if (phoneResendCooldown > 0) {
      return;
    }
    if (!phone.trim()) {
      setPhoneVerificationError('Введите номер телефона.');
      return;
    }

    setIsRequestingCode(true);
    try {
      await requestProfilePhoneCode(phone.trim());
      setPhoneVerificationState('code-sent');
      setPhoneVerificationMessage('Код отправлен.');
      setPhoneResendCooldown(60);
    } catch (requestError) {
      if (requestError instanceof Error) {
        setPhoneVerificationError(requestError.message);
      } else {
        setPhoneVerificationError('Не удалось отправить код.');
      }
    } finally {
      setIsRequestingCode(false);
    }
  };

  const handleVerifyPhoneCode = async () => {
    setPhoneVerificationMessage(null);
    setPhoneVerificationError(null);
    if (!phoneCode.trim()) {
      setPhoneVerificationError('Введите код.');
      return;
    }

    setIsVerifyingPhone(true);
    try {
      await verifyProfilePhoneCode(phone.trim(), phoneCode.trim());
      setPhoneVerificationState('verified');
      setPhoneVerificationMessage(null);
      setPhoneCode('');
    } catch (verifyError) {
      if (verifyError instanceof Error) {
        setPhoneVerificationError(verifyError.message);
      } else {
        setPhoneVerificationError('Код неверный.');
      }
    } finally {
      setIsVerifyingPhone(false);
    }
  };

  const handleEmailChange = (value: string) => {
    setEmail(value);
    setEmailCode('');
    setEmailResendCooldown(0);
    setEmailVerificationMessage(null);
    setEmailVerificationError(null);

    if (!user) {
      return;
    }

    const normalized = value.trim().toLowerCase();
    const original = (user.email ?? '').trim().toLowerCase();
    if (!normalized || normalized === original) {
      setEmailVerificationState('verified');
    } else {
      setEmailVerificationState('idle');
    }
  };

  const handleOpenDetails = async (order: Order) => {
    setDetailsOpen(true);
    setDetailsOrder(order);
    setDetailsItems([]);
    setDetailsState('loading');
    setDetailsError(null);

    try {
      const items = await fetchOrderItems(order.id);
      setDetailsItems(items);
      setDetailsState('ready');
    } catch (loadError) {
      setDetailsError(
        loadError instanceof Error ? loadError.message : 'Не удалось загрузить детали заказа.'
      );
      setDetailsState('error');
    }
  };

  const handleCloseDetails = () => {
    setDetailsOpen(false);
    setDetailsOrder(null);
    setDetailsItems([]);
    setDetailsState('idle');
    setDetailsError(null);
  };

  const handleRequestEmailCode = async () => {
    setEmailVerificationMessage(null);
    setEmailVerificationError(null);
    if (emailResendCooldown > 0) {
      return;
    }
    if (!email.trim()) {
      setEmailVerificationError('Введите почту.');
      return;
    }

    setIsRequestingEmailCode(true);
    try {
      await requestProfileEmailCode(email.trim());
      setEmailVerificationState('code-sent');
      setEmailVerificationMessage('Код отправлен.');
      setEmailResendCooldown(60);
    } catch (requestError) {
      if (requestError instanceof Error) {
        setEmailVerificationError(requestError.message);
      } else {
        setEmailVerificationError('Не удалось отправить код.');
      }
    } finally {
      setIsRequestingEmailCode(false);
    }
  };

  const handleVerifyEmailCode = async () => {
    setEmailVerificationMessage(null);
    setEmailVerificationError(null);
    if (!emailCode.trim()) {
      setEmailVerificationError('Введите код.');
      return;
    }

    setIsVerifyingEmail(true);
    try {
      await verifyProfileEmailCode(email.trim(), emailCode.trim());
      setEmailVerificationState('verified');
      setEmailVerificationMessage(null);
      setEmailCode('');
    } catch (verifyError) {
      if (verifyError instanceof Error) {
        setEmailVerificationError(verifyError.message);
      } else {
        setEmailVerificationError('Код неверный.');
      }
    } finally {
      setIsVerifyingEmail(false);
    }
  };

  const handleLogout = () => {
    logout();
    clear();
    navigate('/');
  };

  if (status === 'loading') {
    return (
      <div className="page">
        <p className="muted">Загружаем профиль...</p>
      </div>
    );
  }

  if (status !== 'auth' || !user) {
    return (
      <div className="page">
        <header className="page-header">
          <div>
            <p className="eyebrow">Личный кабинет</p>
            <h1>Нужна авторизация</h1>
            <p className="muted">Войдите по номеру телефона, чтобы увидеть профиль и заказы.</p>
          </div>
        </header>
        <div className="card">
          <button className="primary-button" onClick={openAuthModal}>
            Войти
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">Личный кабинет</p>
          <h1>Профиль</h1>
          <p className="muted">Управляйте контактами и просматривайте историю заказов.</p>
        </div>
        <div className="button-row">
          {user.role === 'admin' && (
            <Link className="link-button account-admin-link" to="/admin">
              <span>Админ</span>
            </Link>
          )}
          <a
            href="#logout"
            className="admin-logout-link"
            onClick={(event) => {
              event.preventDefault();
              handleLogout();
            }}
          >
            <span className="admin-logout-icon">
              <LogoutIcon />
            </span>
            <span>Выйти</span>
          </a>
        </div>
      </header>
      <div className="grid">
        <div className="card">
          <h3>Контакты</h3>
          {isEditing ? (
            <form className="stacked-form" onSubmit={handleSave}>
              <label className="field">
                <span>ФИО</span>
                <input
                  type="text"
                  value={fullName}
                  onChange={(event) => setFullName(event.target.value)}
                  placeholder="Введите ФИО"
                />
              </label>
              <label className="field">
                <div className="field-header">
                  <span>Телефон</span>
                  {isPhoneChanged && phoneVerificationState === 'idle' && (
                    <button
                      type="button"
                      className="link-button"
                      onClick={handleRequestPhoneCode}
                      disabled={isRequestingCode || phoneResendCooldown > 0}
                    >
                      {isRequestingCode
                        ? 'Отправляем код...'
                        : phoneResendCooldown > 0
                        ? `Повторить через ${phoneResendCooldown}с`
                        : 'Подтвердить номер'}
                    </button>
                  )}
                  {isPhoneChanged && phoneVerificationState === 'verified' && (
                    <span className="status-text">Номер подтвержден</span>
                  )}
                </div>
                <input
                  type="tel"
                  value={phone}
                  onChange={(event) => handlePhoneChange(event.target.value)}
                  placeholder="+7"
                />
                {phoneVerificationState === 'code-sent' && (
                  <>
                    <div className="verify-row">
                      <input
                        type="text"
                        inputMode="numeric"
                        value={phoneCode}
                        onChange={(event) => setPhoneCode(event.target.value)}
                        placeholder="Код из SMS"
                      />
                      <button
                        type="button"
                        className="ghost-button"
                        onClick={handleVerifyPhoneCode}
                        disabled={isVerifyingPhone}
                      >
                        {isVerifyingPhone ? 'Проверяем...' : 'Подтвердить'}
                      </button>
                    </div>
                    <div className="verify-resend">
                      <button
                        type="button"
                        className="link-button"
                        onClick={handleRequestPhoneCode}
                        disabled={isRequestingCode || phoneResendCooldown > 0}
                      >
                        {isRequestingCode
                          ? 'Отправляем код...'
                          : phoneResendCooldown > 0
                          ? `Повторить через ${phoneResendCooldown}с`
                          : 'Отправить код повторно'}
                      </button>
                    </div>
                  </>
                )}
                {phoneNeedsVerification && (
                  <p className="status-text status-text--error">Подтвердите номер.</p>
                )}
                {phoneVerificationMessage && (
                  <p className="status-text">{phoneVerificationMessage}</p>
                )}
                {phoneVerificationError && (
                  <p className="status-text status-text--error">{phoneVerificationError}</p>
                )}
              </label>
              <label className="field">
                <div className="field-header">
                  <span>Почта</span>
                  {isEmailChanged && emailVerificationState === 'idle' && (
                    <button
                      type="button"
                      className="link-button"
                      onClick={handleRequestEmailCode}
                      disabled={isRequestingEmailCode || emailResendCooldown > 0}
                    >
                      {isRequestingEmailCode
                        ? 'Отправляем код...'
                        : emailResendCooldown > 0
                        ? `Повторить через ${emailResendCooldown}с`
                        : 'Подтвердить почту'}
                    </button>
                  )}
                  {isEmailChanged && emailVerificationState === 'verified' && (
                    <span className="status-text">Почта подтверждена</span>
                  )}
                </div>
                <input
                  type="email"
                  value={email}
                  onChange={(event) => handleEmailChange(event.target.value)}
                  placeholder="mail@example.com"
                />
                {emailVerificationState === 'code-sent' && (
                  <>
                    <div className="verify-row">
                      <input
                        type="text"
                        inputMode="numeric"
                        value={emailCode}
                        onChange={(event) => setEmailCode(event.target.value)}
                        placeholder="Код из письма"
                      />
                      <button
                        type="button"
                        className="ghost-button"
                        onClick={handleVerifyEmailCode}
                        disabled={isVerifyingEmail}
                      >
                        {isVerifyingEmail ? 'Проверяем...' : 'Подтвердить'}
                      </button>
                    </div>
                    <div className="verify-resend">
                      <button
                        type="button"
                        className="link-button"
                        onClick={handleRequestEmailCode}
                        disabled={isRequestingEmailCode || emailResendCooldown > 0}
                      >
                        {isRequestingEmailCode
                          ? 'Отправляем код...'
                          : emailResendCooldown > 0
                          ? `Повторить через ${emailResendCooldown}с`
                          : 'Отправить код повторно'}
                      </button>
                    </div>
                  </>
                )}
                {emailNeedsVerification && (
                  <p className="status-text status-text--error">Подтвердите почту.</p>
                )}
                {emailVerificationMessage && (
                  <p className="status-text">{emailVerificationMessage}</p>
                )}
                {emailVerificationError && (
                  <p className="status-text status-text--error">{emailVerificationError}</p>
                )}
              </label>
              {error && <p className="status-text status-text--error">{error}</p>}
              <div className="button-row">
                <button
                  className="primary-button"
                  type="submit"
                  disabled={isSaving || phoneNeedsVerification || emailNeedsVerification}
                >
                  {isSaving ? 'Сохраняем...' : 'Сохранить'}
                </button>
                <button className="ghost-button" type="button" onClick={handleCancel}>
                  Отменить
                </button>
              </div>
            </form>
          ) : (
            <div className="stacked-form">
              <label className="field">
                <span>ФИО</span>
                <input type="text" value={fullName || ''} disabled placeholder="Введите ФИО" />
              </label>
              <label className="field">
                <span>Телефон</span>
                <input type="tel" value={phone} disabled placeholder="+7" />
              </label>
              <label className="field">
                <span>Почта</span>
                <input type="email" value={email || ''} disabled placeholder="mail@example.com" />
              </label>
              {message && <p className="status-text">{message}</p>}
              <div className="button-row">
                <button className="ghost-button" type="button" onClick={handleEdit}>
                  Редактировать
                </button>
              </div>
            </div>
          )}
        </div>
        <div className="card">
          <h3>История заказов</h3>
          {ordersState === 'loading' && <p className="muted">Загружаем заказы...</p>}
          {ordersState === 'error' && (
            <p className="status-text status-text--error">{ordersError}</p>
          )}
          {ordersState === 'ready' && orders.length === 0 && (
            <p className="muted">Заказы появятся после оформления первых покупок.</p>
          )}
          {ordersState === 'ready' && orders.length > 0 && (
            <div className="order-table-wrap">
              <table className="order-table">
                <thead>
                  <tr>
                    <th>Заказ</th>
                    <th>Стоимость</th>
                    <th>Трек-номер</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {orders.map((order) => (
                    <tr key={order.id}>
                      <td>№{order.orderNumber}</td>
                      <td>{formatPrice(order.totalCents)}</td>
                      <td className="muted">-</td>
                      <td>
                        <button
                          type="button"
                          className="text-button"
                          onClick={() => handleOpenDetails(order)}
                        >
                          Детали
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
      {detailsOpen && (
        <div className="modal-backdrop" onClick={handleCloseDetails}>
          <div className="modal-card" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <div>
                <p className="eyebrow">Заказ</p>
                <h3>{detailsOrder ? `Детали заказа №${detailsOrder.orderNumber}` : 'Детали'}</h3>
              </div>
              <button className="icon-button" aria-label="Закрыть" onClick={handleCloseDetails}>
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="17"
                  height="17"
                  viewBox="0 0 17 17"
                  fill="none"
                  aria-hidden="true"
                >
                  <path
                    d="M16.5 0.5L0.5 16.5M16.5 16.5L0.5 0.5"
                    stroke="#433F3C"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            </div>
            {detailsState === 'loading' && <p className="muted">Загружаем позиции...</p>}
            {detailsState === 'error' && (
              <p className="status-text status-text--error">{detailsError}</p>
            )}
            {detailsState === 'ready' && (
              <>
                {detailsItems.length === 0 ? (
                  <p className="muted">Позиции не найдены.</p>
                ) : (
                  <div className="order-details">
                    <div className="order-table-wrap">
                      <table className="order-table order-table--details">
                        <thead>
                          <tr>
                            <th>Позиция</th>
                            <th>Кол-во</th>
                            <th>Цена</th>
                            <th>Сумма</th>
                          </tr>
                        </thead>
                        <tbody>
                          {detailsItems.map((item) => (
                            <tr key={item.productId}>
                              <td>{item.name}</td>
                              <td>{item.quantity}</td>
                              <td>{formatPrice(item.priceCents)}</td>
                              <td>{formatPrice(item.priceCents * item.quantity)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div className="order-details-total">
                      <span className="muted">Итого:</span>
                      <span className="price">
                        {formatPrice(
                          detailsItems.reduce(
                            (sum, item) => sum + item.priceCents * item.quantity,
                            0
                          )
                        )}
                      </span>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default AccountPage;
