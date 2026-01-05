import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchProducts } from '../api';
import type { Product } from '../api';
import { useAuth } from '../context/AuthContext.tsx';
import { useCart } from '../context/CartContext.tsx';
import { useUI } from '../context/UIContext.tsx';
import { formatPrice } from '../utils/formatPrice.ts';

const HomePage = () => {
  const { openProductModal, openNeedPartModal } = useUI();
  const { addItem, decrement, getQuantity, increment, setQuantity } = useCart();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const sliderRef = useRef<HTMLDivElement | null>(null);
  const [featuredProducts, setFeaturedProducts] = useState<Product[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    let active = true;

    const load = async () => {
      try {
        const items = await fetchProducts({ featured: true });
        if (!active) {
          return;
        }
        setFeaturedProducts(items);
        setStatus('ready');
      } catch {
        if (active) {
          setStatus('error');
        }
      }
    };

    load();

    return () => {
      active = false;
    };
  }, []);

  const handleSlide = (direction: 'prev' | 'next') => {
    const track = sliderRef.current;

    if (!track) {
      return;
    }

    const firstCard = track.querySelector<HTMLElement>('.slide');
    const styles = window.getComputedStyle(track);
    const gapValue = styles.columnGap || styles.gap || '0';
    const gap = Number.parseFloat(gapValue) || 0;
    const cardWidth = firstCard?.getBoundingClientRect().width ?? track.clientWidth;
    const scrollAmount = cardWidth + gap;
    track.scrollBy({
      left: direction === 'next' ? scrollAmount : -scrollAmount,
      behavior: 'smooth'
    });
  };

  const handleAddToCart = (product: Product) => {
    addItem({
      id: product.id,
      name: product.name,
      priceCents: product.priceCents,
      image: product.images[0],
      stock: product.stock
    });
  };

  return (
    <div className="page">
      <div className="slider-header">
        <div>
          <p className="eyebrow">Главная</p>
          <h1>Подборка товаров</h1>
          <p className="muted">Товары для слайдера выбираются вручную в админ-панели.</p>
        </div>
        <div className="slider-controls">
          <button className="slider-button" onClick={() => handleSlide('prev')}>
            Назад
          </button>
          <button className="slider-button slider-button--primary" onClick={() => handleSlide('next')}>
            Вперёд
          </button>
        </div>
      </div>

      {status === 'loading' && <p className="muted">Загружаем товары...</p>}
      {status === 'error' && <p className="muted">Не получилось загрузить товары.</p>}
      {status === 'ready' && featuredProducts.length === 0 && (
        <p className="muted">Пока нет товаров для слайдера. Отметьте товары в админке.</p>
      )}
      {status === 'ready' && featuredProducts.length > 0 && (
        <div className="slider-track" ref={sliderRef}>
          {featuredProducts.map((product) => {
            const quantity = getQuantity(product.id);
            const isOutOfStock = product.stock === 0;

            return (
              <article key={product.id} className="slide">
                <div className="product-photo">
                  {product.images[0] ? (
                    <img src={product.images[0]} alt={product.name} />
                  ) : (
                    <span>Фото</span>
                  )}
                </div>
                <div className="product-info">
                  <h3>{product.name}</h3>
                  <p className="price">{formatPrice(product.priceCents)}</p>
                  {isAdmin && <p className="stock-text">Остаток: {product.stock}</p>}
                  <div className="product-actions">
                    <button
                      className="ghost-button"
                      onClick={() =>
                        openProductModal({
                          id: product.id,
                          name: product.name,
                          priceCents: product.priceCents,
                          description: product.description,
                          sku: product.sku,
                          image: product.images[0],
                          stock: product.stock
                        })
                      }
                    >
                      Подробнее
                    </button>
                    {quantity === 0 ? (
                      isOutOfStock ? (
                        <span className="stock-badge">Нет в наличии</span>
                      ) : (
                        <button
                          className="primary-button"
                          onClick={() => handleAddToCart(product)}
                        >
                          В корзину
                        </button>
                      )
                    ) : (
                      <div className="qty-control" role="group" aria-label="Количество товара">
                        <button
                          type="button"
                          className="qty-button"
                          onClick={() => decrement(product.id)}
                          aria-label="Уменьшить количество"
                        >
                          -
                        </button>
                        <input
                          className="qty-input"
                          type="number"
                          min="1"
                          inputMode="numeric"
                          value={quantity}
                          onChange={(event) => {
                            const rawValue = event.target.value;
                            if (rawValue === '') {
                              return;
                            }
                            const next = Number.parseInt(rawValue, 10);
                            if (Number.isNaN(next)) {
                              return;
                            }
                            setQuantity(product.id, next);
                          }}
                        />
                        <button
                          type="button"
                          className="qty-button"
                          onClick={() => increment(product.id)}
                          aria-label="Увеличить количество"
                          disabled={typeof product.stock === 'number' && quantity >= product.stock}
                        >
                          +
                        </button>
                      </div>
                    )}
                    {isOutOfStock && (
                      <button
                        type="button"
                        className="text-button need-help-link"
                        onClick={() =>
                          openNeedPartModal({
                            id: product.id,
                            name: product.name,
                            priceCents: product.priceCents,
                            description: product.description,
                            sku: product.sku,
                            image: product.images[0],
                            stock: product.stock
                          })
                        }
                      >
                        Помогите, нужна деталь
                      </button>
                    )}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}

      <div className="home-actions">
        <Link to="/catalog/prof-zapchasti" className="primary-button">
          Проф. запчасти
        </Link>
        <Link to="/catalog/bytovye" className="ghost-button">
          Бытовые
        </Link>
      </div>
    </div>
  );
};

export default HomePage;
