import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { searchProductsBySku } from '../api';
import type { Product } from '../api';
import ProductMiniCard from '../components/ProductMiniCard.tsx';
import { useAuth } from '../context/AuthContext.tsx';
import { useCart } from '../context/CartContext.tsx';
import { useUI } from '../context/UIContext.tsx';

const SearchPage = () => {
  const [searchParams] = useSearchParams();
  const query = (searchParams.get('q') ?? '').trim();
  const { openProductModal, openNeedPartModal } = useUI();
  const { addItem, decrement, getQuantity, increment, setQuantity } = useCart();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';

  const [products, setProducts] = useState<Product[]>([]);
  const [total, setTotal] = useState(0);
  const [usedFallback, setUsedFallback] = useState(false);
  const [fallbackPrefix, setFallbackPrefix] = useState<string | null>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');

  useEffect(() => {
    if (!query) {
      setProducts([]);
      setTotal(0);
      setUsedFallback(false);
      setFallbackPrefix(null);
      setStatus('idle');
      return;
    }

    let active = true;
    setStatus('loading');

    searchProductsBySku(query)
      .then((result) => {
        if (!active) {
          return;
        }
        setProducts(result.items);
        setTotal(result.total);
        setUsedFallback(result.usedFallback);
        setFallbackPrefix(result.fallbackPrefix);
        setStatus('ready');
      })
      .catch(() => {
        if (!active) {
          return;
        }
        setStatus('error');
      });

    return () => {
      active = false;
    };
  }, [query]);

  const handleAddToCart = (product: Product) => {
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

  const handleOpenProduct = (product: Product) => {
    openProductModal({
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
      weightGrams: product.weightGrams,
      lengthCm: product.lengthCm,
      widthCm: product.widthCm,
      heightCm: product.heightCm,
      stock: product.stock
    });
  };

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">Поиск по артикулу</p>
          <h1>Результаты поиска</h1>
          {query ? (
            <p className="muted">Запрос: «{query}»</p>
          ) : (
            <p className="muted">Введите артикул товара в строке поиска в шапке сайта.</p>
          )}
        </div>
        <Link to="/catalog" className="link-button">
          Назад к каталогу
        </Link>
      </header>

      {status === 'loading' && <p className="muted">Ищем товары...</p>}
      {status === 'error' && <p className="muted">Не удалось выполнить поиск. Попробуйте еще раз.</p>}
      {status === 'idle' && (
        <div className="card">
          <h3>Введите артикул</h3>
          <p className="muted">
            Можно искать без знаков препинания. Например: 2.885-238,1 или 28852381.
          </p>
        </div>
      )}
      {status === 'ready' && (
        <>
          <p className="muted">Найдено: {total}</p>
          {usedFallback && (
            <p className="muted">
              По точному запросу совпадений не найдено. Показаны товары по первым 4 цифрам
              артикула{fallbackPrefix ? `: ${fallbackPrefix}` : ''}.
            </p>
          )}
          {products.length === 0 ? (
            <div className="card">
              <h3>Ничего не найдено</h3>
              <p className="muted">
                Проверьте артикул и попробуйте поискать без знаков препинания.
              </p>
            </div>
          ) : (
            <div className="products-grid">
              {products.map((product) => (
                <ProductMiniCard
                  key={product.id}
                  product={product}
                  quantity={getQuantity(product.id)}
                  isAdmin={isAdmin}
                  onOpen={handleOpenProduct}
                  onAddToCart={handleAddToCart}
                  onNeedPart={handleNeedPart}
                  onDecrement={decrement}
                  onIncrement={increment}
                  onSetQuantity={setQuantity}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default SearchPage;
