import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { fetchCategories, fetchProductsPage } from '../api';
import type { Product } from '../api';
import ProductMiniCard from '../components/ProductMiniCard.tsx';
import { useAuth } from '../context/AuthContext.tsx';
import { useCart } from '../context/CartContext.tsx';
import { useUI } from '../context/UIContext.tsx';
import { SITE_URL, usePageSeo } from '../utils/usePageSeo.ts';

const PRODUCTS_PAGE_SIZE = 24;
const PRODUCT_SCHEMA_LIMIT = 12;

type CategorySeo = {
  title: string;
  description: string;
  h1: string;
  subtitle: string;
};

const normalizeSeoKey = (value: string) =>
  value.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();

const hasAnyKeyword = (value: string, keywords: string[]) =>
  keywords.some((keyword) => value.includes(keyword));

const resolveCategorySeo = (slug: string, categoryTitle: string): CategorySeo => {
  const key = normalizeSeoKey(`${slug} ${categoryTitle}`);

  if (hasAnyKeyword(key, ['bytov', 'бытов'])) {
    return {
      title: 'Запчасти для бытовой техники Karcher — купить запчасти | СТ-24',
      description:
        'Запчасти для бытовой техники Karcher от производителя СТ-24. Детали выполнены из качественных материалов.Запчасти для аппаратов Karcher K3,K4,K5,K7. Гарантия качества и доступные цены.',
      h1: 'Запчасти для бытовых аппаратов',
      subtitle: 'Подберите нужные детали и оформите заказ с доставкой по России.'
    };
  }

  if (hasAnyKeyword(key, ['prof', 'проф', 'professional'])) {
    return {
      title: 'Запчасти для профессиональной техники Karcher — купить запчасти | СТ-24',
      description:
        'Запчасти для профессиональной техники Karcher от производителя СТ-24. Детали выполнены из качественных материалов.Запчасти для аппаратов Karcher HD 9/20,HD10/21,HD10/22,HD10/23,HD10/25. Гарантия качества и доступные цены.',
      h1: 'Запчасти для профессиональных аппаратов',
      subtitle: 'Подберите нужные детали и оформите заказ с доставкой по России.'
    };
  }

  if (hasAnyKeyword(key, ['оригин', 'origin'])) {
    return {
      title: 'Оригинальные запчасти для техники Karcher — купить запчасти',
      description: 'Оригинальные запчасти для техники Karcher от производителя.',
      h1: 'Каталог запчастей для Karcher',
      subtitle: 'Подберите нужные детали и оформите заказ с доставкой по России.'
    };
  }

  if (hasAnyKeyword(key, ['резин', 'манжет', 'сальн', 'уплот', 'seal'])) {
    return {
      title:
        'Резиновые изделия для аппаратов Karcher - манжеты, сальники и уплотнительные кольца',
      description:
        'Манжеты, сальники и уплотнительные кольца для Karcher. Всё для удобной работы с техникой. Доставка по России.',
      h1: 'Каталог манжет и уплотнительных колец',
      subtitle: 'Подберите нужные детали и оформите заказ с доставкой по России.'
    };
  }

  const fallbackTitle = categoryTitle.trim() || slug.trim() || 'Категория';
  return {
    title: `${fallbackTitle} — запчасти для Karcher | СТ-24`,
    description:
      'Запчасти для техники Karcher от производителя СТ-24. Надежные комплектующие и доставка по России.',
    h1: fallbackTitle,
    subtitle: 'Выберите товар и добавьте его в корзину.'
  };
};

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

  const seo = useMemo(() => resolveCategorySeo(slug ?? '', categoryTitle), [categoryTitle, slug]);
  const categoryPath = slug ? `/catalog/${slug}` : '/catalog';
  const categoryUrl = `${SITE_URL}${categoryPath}`;
  const breadcrumbJsonLd = useMemo(
    () => ({
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
          name: 'Каталог запчастей',
          item: `${SITE_URL}/catalog`
        },
        {
          '@type': 'ListItem',
          position: 3,
          name: seo.h1,
          item: categoryUrl
        }
      ]
    }),
    [categoryUrl, seo.h1]
  );
  const productListJsonLd = useMemo(() => {
    const listedProducts = products.slice(0, PRODUCT_SCHEMA_LIMIT);
    if (listedProducts.length === 0) {
      return null;
    }

    return {
      '@context': 'https://schema.org',
      '@type': 'ItemList',
      name: seo.h1,
      itemListElement: listedProducts.map((product, index) => ({
        '@type': 'ListItem',
        position: index + 1,
        item: {
          '@type': 'Product',
          name: product.name,
          description: product.description,
          sku: product.sku,
          image: product.images[0] ?? undefined,
          brand: {
            '@type': 'Brand',
            name: 'Karcher'
          },
          offers: {
            '@type': 'Offer',
            priceCurrency: 'RUB',
            price: (product.priceCents / 100).toFixed(2),
            availability:
              product.stock > 0
                ? 'https://schema.org/InStock'
                : 'https://schema.org/OutOfStock',
            url: categoryUrl
          }
        }
      }))
    };
  }, [categoryUrl, products, seo.h1]);
  const pageJsonLd = useMemo(() => {
    if (!productListJsonLd) {
      return [breadcrumbJsonLd];
    }
    return [breadcrumbJsonLd, productListJsonLd];
  }, [breadcrumbJsonLd, productListJsonLd]);

  usePageSeo(seo.title, seo.description, {
    jsonLd: pageJsonLd
  });

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
          <p className="eyebrow">Раздел каталога</p>
          <h1>{seo.h1}</h1>
          <p className="muted">{seo.subtitle}</p>
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
          {isAdmin && (
            <Link to="/admin" className="primary-button">
              Перейти в админку
            </Link>
          )}
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
          {isLoadingMore ? <p className="muted">Загружаем еще товары...</p> : null}
          {loadMoreError ? <p className="muted">{loadMoreError}</p> : null}
        </>
      )}
    </div>
  );
};

export default CategoryPage;
