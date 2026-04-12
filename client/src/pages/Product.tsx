import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { fetchCategories, fetchProductById } from '../api.ts';
import type { Product } from '../api.ts';
import ProductImageSlider from '../components/ProductImageSlider.tsx';
import QuantityStepIcon from '../components/QuantityStepIcon.tsx';
import { useAuth } from '../context/AuthContext.tsx';
import { useCart } from '../context/CartContext.tsx';
import { useUI } from '../context/UIContext.tsx';
import { formatPrice } from '../utils/formatPrice.ts';
import { SITE_URL, usePageSeo } from '../utils/usePageSeo.ts';

type ProductTab = 'description' | 'specs';

const ProductPage = () => {
  const { id } = useParams<{ id: string }>();
  const { status: authStatus, user } = useAuth();
  const isAdmin = user?.role === 'admin' || user?.role === 'superadmin';
  const { openNeedPartModal } = useUI();
  const { addItem, decrement, getQuantity, increment, setQuantity } = useCart();

  const [product, setProduct] = useState<Product | null>(null);
  const [categoryName, setCategoryName] = useState('');
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [activeTab, setActiveTab] = useState<ProductTab>('description');
  const productPath = id ? `/product/${id}` : '/catalog';
  const productUrl = `${SITE_URL}${productPath}`;

  const pageJsonLd = useMemo(() => {
    if (!product) {
      return null;
    }

    const breadcrumb = {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        {
          '@type': 'ListItem',
          position: 1,
          name: 'Главная',
          item: `${SITE_URL}/`
        },
        {
          '@type': 'ListItem',
          position: 2,
          name: categoryName || product.category,
          item: `${SITE_URL}/catalog/${product.category}`
        },
        {
          '@type': 'ListItem',
          position: 3,
          name: product.name,
          item: productUrl
        }
      ]
    };

    const productSchema = {
      '@context': 'https://schema.org',
      '@type': 'Product',
      name: product.name,
      sku: product.sku,
      mpn: product.sku,
      description: product.description || undefined,
      image: product.images,
      category: categoryName || product.category,
      brand: {
        '@type': 'Brand',
        name: 'Karcher'
      },
      offers: {
        '@type': 'Offer',
        priceCurrency: 'RUB',
        price: (product.priceCents / 100).toFixed(2),
        availability:
          product.stock > 0 ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
        itemCondition: 'https://schema.org/NewCondition',
        url: productUrl
      }
    };

    return [breadcrumb, productSchema];
  }, [categoryName, product, productUrl]);

  usePageSeo(
    product ? `${product.name} — артикул ${product.sku} | СТ-24` : 'Карточка товара | СТ-24',
    product
      ? `${product.name}, артикул ${product.sku}. Цена и наличие в каталоге СТ-24.`
      : 'Страница товара в каталоге СТ-24.',
    {
      canonicalPath: productPath,
      robots: 'index,follow',
      jsonLd: pageJsonLd ?? undefined
    }
  );

  useEffect(() => {
    setActiveTab('description');
  }, [id]);

  useEffect(() => {
    if (!id) {
      setStatus('error');
      setProduct(null);
      setCategoryName('');
      return;
    }

    if (authStatus === 'loading') {
      return;
    }

    let active = true;
    setStatus('loading');

    fetchProductById(id, { includeHidden: isAdmin })
      .then(async (item) => {
        if (!active) {
          return;
        }
        setProduct(item);
        try {
          const categories = await fetchCategories();
          if (!active) {
            return;
          }
          const matched = categories.find((category) => category.slug === item.category);
          setCategoryName(matched?.name ?? item.category);
        } catch {
          if (!active) {
            return;
          }
          setCategoryName(item.category);
        }
        setStatus('ready');
      })
      .catch(() => {
        if (!active) {
          return;
        }
        setProduct(null);
        setCategoryName('');
        setStatus('error');
      });

    return () => {
      active = false;
    };
  }, [authStatus, id, isAdmin]);

  const quantity = product ? getQuantity(product.id) : 0;
  const isOutOfStock = product?.stock === 0;
  const stockValue = product?.stock && product.stock > 0 ? String(product.stock) : 'Нет в наличии';

  const handleAddToCart = () => {
    if (!product) {
      return;
    }
    addItem({
      id: product.id,
      name: product.name,
      priceCents: product.priceCents,
      image: product.images[0],
      stock: product.stock,
      weightGrams: product.weightGrams,
      lengthCm: product.lengthCm,
      widthCm: product.widthCm,
      heightCm: product.heightCm
    });
  };

  if (status === 'loading') {
    return (
      <div className="page">
        <p className="muted">Загружаем товар...</p>
      </div>
    );
  }

  if (status === 'error' || !product) {
    return (
      <div className="page">
        <header className="page-header">
          <div>
            <p className="eyebrow">Товар</p>
            <h1>Товар не найден</h1>
            <p className="muted">Проверьте ссылку или вернитесь в каталог.</p>
          </div>
        </header>
        <div className="card">
          <Link to="/catalog" className="primary-button">
            В каталог
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">Карточка товара</p>
        </div>
        <Link to={product.category ? `/catalog/${product.category}` : '/catalog'} className="link-button">
          Назад
        </Link>
      </header>

      <div className="product-page-card">
        <div className="product-page-layout">
          <div className="product-page-left">
            <ProductImageSlider
              className="product-page-image"
              images={product.images}
              alt={product.name}
              reserveControlsSpace={false}
            />
          </div>

          <div className="product-page-right">
            <h1 className="product-page-title">{product.name}</h1>
            <p className="product-page-meta">
              <span className="product-page-meta-label">Артикул:</span>
              <span className="product-page-meta-value">{product.sku || '—'}</span>
            </p>
            <p className="product-page-meta">
              <span className="product-page-meta-label">Категория:</span>
              <span className="product-page-meta-value">{categoryName || product.category}</span>
            </p>
            <p className={`product-page-meta product-page-stock${isOutOfStock ? ' is-out-of-stock' : ''}`}>
              <span className="product-page-meta-label">В наличии:</span>
              <span className="product-page-meta-value">{stockValue}</span>
            </p>

            <div className="product-page-buy-row">
              {quantity === 0 ? (
                isOutOfStock ? (
                  <span className="stock-badge">Нет в наличии</span>
                ) : (
                  <button className="primary-button" onClick={handleAddToCart}>
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
                    <QuantityStepIcon type="minus" />
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
                    <QuantityStepIcon type="plus" />
                  </button>
                </div>
              )}
              <p className="price product-page-price">{formatPrice(product.priceCents)}</p>
            </div>

            <div className="product-page-tabs" role="tablist" aria-label="Разделы товара">
              <button
                type="button"
                className={`product-page-tab${activeTab === 'description' ? ' is-active' : ''}`}
                role="tab"
                id="product-tab-description"
                aria-controls="product-tab-panel-description"
                aria-selected={activeTab === 'description'}
                onClick={() => setActiveTab('description')}
              >
                Описание
              </button>
              <button
                type="button"
                className={`product-page-tab${activeTab === 'specs' ? ' is-active' : ''}`}
                role="tab"
                id="product-tab-specs"
                aria-controls="product-tab-panel-specs"
                aria-selected={activeTab === 'specs'}
                onClick={() => setActiveTab('specs')}
              >
                Характеристики
              </button>
            </div>

            {activeTab === 'description' ? (
              <div
                className="product-page-tab-panel"
                role="tabpanel"
                id="product-tab-panel-description"
                aria-labelledby="product-tab-description"
              >
                <p className="muted product-page-description">
                  {product.description || 'Описание появится позже.'}
                </p>
              </div>
            ) : (
              <div
                className="product-page-tab-panel"
                role="tabpanel"
                id="product-tab-panel-specs"
                aria-labelledby="product-tab-specs"
              >
                <ul className="product-page-specs">
                  <li className="product-page-spec-item">
                    <span className="product-page-meta-label">Вес:</span>
                    <span className="product-page-meta-value">
                      {product.weightGrams ? `${product.weightGrams} г` : '—'}
                    </span>
                  </li>
                  <li className="product-page-spec-item">
                    <span className="product-page-meta-label">Длина:</span>
                    <span className="product-page-meta-value">
                      {product.lengthCm != null ? `${product.lengthCm} см` : '—'}
                    </span>
                  </li>
                  <li className="product-page-spec-item">
                    <span className="product-page-meta-label">Ширина:</span>
                    <span className="product-page-meta-value">
                      {product.widthCm != null ? `${product.widthCm} см` : '—'}
                    </span>
                  </li>
                  <li className="product-page-spec-item">
                    <span className="product-page-meta-label">Высота:</span>
                    <span className="product-page-meta-value">
                      {product.heightCm != null ? `${product.heightCm} см` : '—'}
                    </span>
                  </li>
                </ul>
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
                    images: product.images,
                    weightGrams: product.weightGrams,
                    lengthCm: product.lengthCm,
                    widthCm: product.widthCm,
                    heightCm: product.heightCm,
                    stock: product.stock
                  })
                }
              >
                Помогите, нужна деталь
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default ProductPage;
