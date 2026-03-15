import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { searchProductsBySku } from '../api';
import type { Product } from '../api';
import ProductMiniCard from '../components/ProductMiniCard.tsx';
import { useAuth } from '../context/AuthContext.tsx';
import { useCart } from '../context/CartContext.tsx';
import { useUI } from '../context/UIContext.tsx';

const SEARCH_PAGE_SIZE = 24;

const SearchPage = () => {
  const [searchParams] = useSearchParams();
  const query = (searchParams.get('q') ?? '').trim();
  const { openProductModal, openNeedPartModal } = useUI();
  const { addItem, decrement, getQuantity, increment, setQuantity } = useCart();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const loadMoreTriggerRef = useRef<HTMLDivElement | null>(null);
  const searchSessionRef = useRef(0);

  const [products, setProducts] = useState<Product[]>([]);
  const [total, setTotal] = useState(0);
  const [usedFallback, setUsedFallback] = useState(false);
  const [fallbackPrefix, setFallbackPrefix] = useState<string | null>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [nextOffset, setNextOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);

  useEffect(() => {
    searchSessionRef.current += 1;
    if (!query) {
      setProducts([]);
      setTotal(0);
      setUsedFallback(false);
      setFallbackPrefix(null);
      setStatus('idle');
      setNextOffset(0);
      setHasMore(false);
      setIsLoadingMore(false);
      setLoadMoreError(null);
      return;
    }

    const sessionId = searchSessionRef.current;
    let active = true;
    setStatus('loading');
    setProducts([]);
    setTotal(0);
    setUsedFallback(false);
    setFallbackPrefix(null);
    setNextOffset(0);
    setHasMore(false);
    setIsLoadingMore(false);
    setLoadMoreError(null);

    searchProductsBySku(query, { limit: SEARCH_PAGE_SIZE, offset: 0 })
      .then((result) => {
        if (!active || searchSessionRef.current !== sessionId) {
          return;
        }
        setProducts(result.items);
        setTotal(result.total);
        setUsedFallback(result.usedFallback);
        setFallbackPrefix(result.fallbackPrefix);
        setHasMore(result.hasMore);
        setNextOffset(result.nextOffset ?? result.offset + result.items.length);
        setStatus('ready');
      })
      .catch(() => {
        if (!active || searchSessionRef.current !== sessionId) {
          return;
        }
        setStatus('error');
      });

    return () => {
      active = false;
    };
  }, [query]);

  const loadMore = useCallback(async () => {
    if (!query || status !== 'ready' || !hasMore || isLoadingMore) {
      return;
    }

    const sessionId = searchSessionRef.current;
    setIsLoadingMore(true);
    setLoadMoreError(null);
    try {
      const result = await searchProductsBySku(query, {
        limit: SEARCH_PAGE_SIZE,
        offset: nextOffset
      });
      if (searchSessionRef.current !== sessionId) {
        return;
      }
      setProducts((prev) => {
        if (prev.length === 0) {
          return result.items;
        }
        const existingIds = new Set(prev.map((item) => item.id));
        const append = result.items.filter((item) => !existingIds.has(item.id));
        return [...prev, ...append];
      });
      setTotal(result.total);
      setUsedFallback(result.usedFallback);
      setFallbackPrefix(result.fallbackPrefix);
      setHasMore(result.hasMore);
      setNextOffset(result.nextOffset ?? nextOffset + result.items.length);
    } catch {
      if (searchSessionRef.current !== sessionId) {
        return;
      }
      setLoadMoreError('Не удалось загрузить следующую партию товаров.');
    } finally {
      if (searchSessionRef.current === sessionId) {
        setIsLoadingMore(false);
      }
    }
  }, [hasMore, isLoadingMore, nextOffset, query, status]);

  useEffect(() => {
    if (status !== 'ready' || !hasMore) {
      return;
    }

    const target = loadMoreTriggerRef.current;
    if (!target) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          void loadMore();
        }
      },
      { rootMargin: '400px 0px' }
    );
    observer.observe(target);

    return () => {
      observer.disconnect();
    };
  }, [hasMore, loadMore, status]);

  const handleAddToCart = useCallback(
    (product: Product) => {
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
    },
    [addItem]
  );

  const handleOpenProduct = useCallback(
    (product: Product) => {
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
    },
    [openProductModal]
  );

  const handleNeedPart = useCallback(
    (product: Product) => {
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
    },
    [openNeedPartModal]
  );

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
              По точному запросу совпадений не найдено. Показаны товары по первым 4 символам
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
            <>
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
              {hasMore ? <div ref={loadMoreTriggerRef} style={{ height: 1 }} aria-hidden="true" /> : null}
              {isLoadingMore ? <p className="muted">Загружаем еще товары...</p> : null}
              {loadMoreError ? <p className="muted">{loadMoreError}</p> : null}
              {!hasMore && !isLoadingMore && !loadMoreError ? (
                <p className="muted">Вы достигли конца списка.</p>
              ) : null}
            </>
          )}
        </>
      )}
    </div>
  );
};

export default SearchPage;
