import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useCart } from '../context/CartContext.tsx';
import { useAuth } from '../context/AuthContext.tsx';
import { useUI } from '../context/UIContext.tsx';
import { formatPrice } from '../utils/formatPrice.ts';

const CartPage = () => {
  const navigate = useNavigate();
  const { status } = useAuth();
  const { openAuthModal } = useUI();
  const {
    items,
    totalCount,
    totalPriceCents,
    increment,
    decrement,
    removeItem,
    clear,
    refreshFromServer
  } = useCart();
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [isChecking, setIsChecking] = useState(false);

  const hasStockIssues = items.some(
    (item) => typeof item.stock === 'number' && item.quantity > item.stock
  );

  const handleCheckout = async () => {
    if (status === 'auth') {
      setCheckoutError(null);
      setIsChecking(true);
      try {
        const latest = await refreshFromServer();
        const hasIssues = latest.some(
          (item) => typeof item.stock === 'number' && item.quantity > item.stock
        );
        if (hasIssues) {
          setCheckoutError(
            'Некоторых товаров нет в нужном количестве. Проверьте ограничения.'
          );
          return;
        }
        navigate('/checkout');
      } catch {
        setCheckoutError('Не удалось проверить остатки. Попробуйте снова.');
      } finally {
        setIsChecking(false);
      }
      return;
    }
    openAuthModal();
  };

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">Корзина и оформление</p>
          <h1>Корзина</h1>
          <p className="muted">Проверьте состав заказа и количество товаров.</p>
        </div>
      </header>
      {items.length === 0 ? (
        <div className="card">
          <h3>Корзина пустая</h3>
          <p className="muted">Добавьте товары из каталога и вернитесь сюда.</p>
          <Link to="/catalog" className="primary-button">
            Перейти в каталог
          </Link>
        </div>
      ) : (
        <div className="cart-layout">
          <div className="cart-items">
            {items.map((item) => (
              <article key={item.id} className="cart-item">
                <div className="cart-thumb">
                  {item.image ? <img src={item.image} alt={item.name} /> : <span>Фото</span>}
                </div>
                <div className="cart-details">
                  <h3>{item.name}</h3>
                  <p className="muted">{formatPrice(item.priceCents)} за шт.</p>
                  <div className="cart-actions">
                    <div className="qty-control" role="group" aria-label="Количество товара">
                      <button
                        type="button"
                        className="qty-button"
                        onClick={() => decrement(item.id)}
                        aria-label="Уменьшить количество"
                      >
                        -
                      </button>
                      <span className="qty-value">{item.quantity}</span>
                      <button
                        type="button"
                        className="qty-button"
                        onClick={() => increment(item.id)}
                        aria-label="Увеличить количество"
                        disabled={
                          typeof item.stock === 'number' && item.quantity >= item.stock
                        }
                      >
                        +
                      </button>
                    </div>
                    <button type="button" className="text-button" onClick={() => removeItem(item.id)}>
                      Удалить
                    </button>
                  </div>
                  {typeof item.stock === 'number' && item.quantity > item.stock && (
                    <p className="status-text status-text--error">
                      Доступно максимум {item.stock} шт.
                    </p>
                  )}
                </div>
                <div className="cart-total">
                  <p className="price">{formatPrice(item.priceCents * item.quantity)}</p>
                  <p className="muted">{item.quantity} шт.</p>
                </div>
              </article>
            ))}
          </div>
          <aside className="cart-summary card">
            <h3>Итого</h3>
            <p className="muted">Товаров: {totalCount}</p>
            <p className="price">{formatPrice(totalPriceCents)}</p>
            {checkoutError && <p className="status-text status-text--error">{checkoutError}</p>}
            {!checkoutError && hasStockIssues && (
              <p className="status-text status-text--error">
                Скорректируйте количество товаров с ограничением.
              </p>
            )}
            <div className="cart-summary-actions">
              <button
                className="primary-button"
                onClick={handleCheckout}
                disabled={isChecking || hasStockIssues}
              >
                {isChecking ? 'Проверяем остатки...' : 'Оформление заказа'}
              </button>
              <button type="button" className="ghost-button" onClick={clear}>
                Очистить корзину
              </button>
            </div>
          </aside>
        </div>
      )}
    </div>
  );
};

export default CartPage;
