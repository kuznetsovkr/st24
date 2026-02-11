import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { fetchProducts } from '../api';
import type { Product } from '../api';
import ProductImageSlider from '../components/ProductImageSlider.tsx';
import { useAuth } from '../context/AuthContext.tsx';
import { useCart } from '../context/CartContext.tsx';
import { useUI } from '../context/UIContext.tsx';
import { formatPrice } from '../utils/formatPrice.ts';

const CategoryPage = () => {
  const { slug } = useParams<{ slug: string }>();
  const { openProductModal, openNeedPartModal } = useUI();
  const { addItem, decrement, getQuantity, increment, setQuantity } = useCart();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [products, setProducts] = useState<Product[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    if (!slug) {
      setStatus('error');
      return;
    }

    let active = true;

    const load = async () => {
      try {
        setStatus('loading');
        const items = await fetchProducts({ category: slug });
        if (!active) {
          return;
        }
        setProducts(items);
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
  }, [slug]);

  const handleAddToCart = (product: Product) => {
    addItem({
      id: product.id,
      name: product.name,
      priceCents: product.priceCents,
      image: product.images[0],
      stock: product.stock
    });
  };

  const handleOpenProduct = (product: Product) => {
    openProductModal({
      id: product.id,
      name: product.name,
      priceCents: product.priceCents,
      description: product.description,
      sku: product.sku,
      image: product.images[0],
      images: product.images,
      stock: product.stock
    });
  };

  const handleNeedPart = (product: Product) => {
    openNeedPartModal({
      id: product.id,
      name: product.name,
      priceCents: product.priceCents,
      description: product.description,
      sku: product.sku,
      image: product.images[0],
      images: product.images,
      stock: product.stock
    });
  };

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">Раздел каталога</p>
          <h1>{slug ? `Категория: ${slug}` : 'Категория'}</h1>
          <p className="muted">Выберите товар и добавьте его в корзину.</p>
        </div>
        <Link to="/catalog" className="ghost-button">
          Назад к каталогу
        </Link>
      </header>
      {status === 'loading' && <p className="muted">Загружаем товары...</p>}
      {status === 'error' && <p className="muted">Не удалось загрузить товары.</p>}
      {status === 'ready' && products.length === 0 && (
        <div className="card">
          <h3>В этом разделе пока нет товаров</h3>
          <p className="muted">Добавьте позиции в админке, и они появятся здесь.</p>
          <Link to="/admin" className="primary-button">
            Перейти в админку
          </Link>
        </div>
      )}
      {status === 'ready' && products.length > 0 && (
        <div className="products-grid">
          {products.map((product) => {
            const quantity = getQuantity(product.id);
            const isOutOfStock = product.stock === 0;

            return (
              <article
                key={product.id}
                className="product-card product-card--clickable"
                onClick={() => handleOpenProduct(product)}
              >
                <ProductImageSlider
                  className="product-image"
                  images={product.images}
                  alt={product.name}
                />
                <div className="product-meta">
                  <h3>{product.name}</h3>
                  <p className="price">{formatPrice(product.priceCents)}</p>
                  {isAdmin && <p className="stock-text">Остаток: {product.stock}</p>}
                  {product.description && <p className="muted">{product.description}</p>}
                  <div className="product-actions">
                    <button
                      className="ghost-button"
                      onClick={(event) => {
                        event.stopPropagation();
                        handleOpenProduct(product);
                      }}
                    >
                      Подробнее
                    </button>
                    {quantity === 0 ? (
                      isOutOfStock ? (
                        <span className="stock-badge">Нет в наличии</span>
                      ) : (
                        <button
                          className="primary-button"
                          onClick={(event) => {
                            event.stopPropagation();
                            handleAddToCart(product);
                          }}
                        >
                          В корзину
                        </button>
                      )
                    ) : (
                      <div className="qty-control" role="group" onClick={(event) => event.stopPropagation()} aria-label="Количество товара">
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
                        onClick={(event) => {
                          event.stopPropagation();
                          handleNeedPart(product);
                        }}
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
    </div>
  );
};

export default CategoryPage;
