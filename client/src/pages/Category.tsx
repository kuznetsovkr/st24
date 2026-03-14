import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { fetchCategories, fetchProductsPage } from '../api';
import type { Product } from '../api';
import ProductMiniCard from '../components/ProductMiniCard.tsx';
import { useAuth } from '../context/AuthContext.tsx';
import { useCart } from '../context/CartContext.tsx';
import { useUI } from '../context/UIContext.tsx';

const PRODUCTS_PAGE_SIZE = 24;

const CategoryPage = () => {
  const { slug } = useParams<{ slug: string }>();
  const { openProductModal, openNeedPartModal } = useUI();
  const { addItem, decrement, getQuantity, increment, setQuantity } = useCart();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const loadMoreTriggerRef = useRef<HTMLDivElement | null>(null);

  const [products, setProducts] = useState<Product[]>([]);
  const [categoryTitle, setCategoryTitle] = useState('');
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [nextOffset, setNextOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);

  useEffect(() => {
    if (!slug) {
      setStatus('error');
      setCategoryTitle('');
      setProducts([]);
      setNextOffset(0);
      setHasMore(false);
      setLoadMoreError(null);
      return;
    }

    let active = true;
    setStatus('loading');
    setProducts([]);
    setNextOffset(0);
    setHasMore(false);
    setLoadMoreError(null);
    setIsLoadingMore(false);

    const load = async () => {
      try {
        const [page, categories] = await Promise.all([
          fetchProductsPage({
            category: slug,
            limit: PRODUCTS_PAGE_SIZE,
            offset: 0
          }),
          fetchCategories().catch(() => [])
        ]);
        if (!active) {
          return;
        }
        const matchedCategory = categories.find((category) => category.slug === slug);
        setCategoryTitle(matchedCategory?.name ?? slug);
        setProducts(page.items);
        setHasMore(page.hasMore);
        setNextOffset(page.nextOffset ?? page.offset + page.items.length);
        setStatus('ready');
      } catch {
        if (active) {
          setStatus('error');
          setProducts([]);
          setHasMore(false);
        }
      }
    };

    void load();

    return () => {
      active = false;
    };
  }, [slug]);

  const loadMore = useCallback(async () => {
    if (!slug || !hasMore || isLoadingMore) {
      return;
    }

    setIsLoadingMore(true);
    setLoadMoreError(null);
    try {
      const page = await fetchProductsPage({
        category: slug,
        limit: PRODUCTS_PAGE_SIZE,
        offset: nextOffset
      });
      setProducts((prev) => {
        if (prev.length === 0) {
          return page.items;
        }
        const existingIds = new Set(prev.map((item) => item.id));
        const append = page.items.filter((item) => !existingIds.has(item.id));
        return [...prev, ...append];
      });
      setHasMore(page.hasMore);
      setNextOffset(page.nextOffset ?? nextOffset + page.items.length);
    } catch {
      setLoadMoreError('Не удалось загрузить следующую партию товаров.');
    } finally {
      setIsLoadingMore(false);
    }
  }, [hasMore, isLoadingMore, nextOffset, slug]);

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
          <p className="eyebrow">Раздел каталога</p>
          <h1>{slug ? `${categoryTitle || slug}` : 'Категория'}</h1>
          <p className="muted">Выберите товар и добавьте его в корзину.</p>
        </div>
        <Link to="/catalog" className="link-button">
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
          {isLoadingMore ? <p className="muted">Загружаем ещё товары...</p> : null}
          {loadMoreError ? <p className="muted">{loadMoreError}</p> : null}
        </>
      )}
    </div>
  );
};

export default CategoryPage;
