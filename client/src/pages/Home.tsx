import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { fetchHomeBanner, fetchProducts } from '../api';
import type { HomeBanner, Product } from '../api';
import ProductMiniCard from '../components/ProductMiniCard.tsx';
import { useAuth } from '../context/AuthContext.tsx';
import { useCart } from '../context/CartContext.tsx';
import { useUI } from '../context/UIContext.tsx';
import { SITE_URL, usePageSeo } from '../utils/usePageSeo.ts';

const AUTO_SCROLL_INTERVAL_MS = 10000;
const AUTO_SCROLL_BATCH_SIZE = 5;
const PROGRAMMATIC_SCROLL_LOCK_MS = 450;
const LOOP_RESET_DELAY_MS = 520;
const FALLBACK_DESKTOP_BANNER = '/banners/16_9.png';
const FALLBACK_MOBILE_BANNER = '/banners/4_3.png';
const FEATURED_PRODUCTS_LIMIT_DESKTOP = 80;
const FEATURED_PRODUCTS_LIMIT_TOUCH = 40;
const TOUCH_DEVICE_QUERY = '(hover: none) and (pointer: coarse)';
const MOBILE_BANNER_MEDIA_QUERY = '(max-width: 1024px), (hover: none) and (pointer: coarse)';
const FEATURED_PRODUCTS_CACHE_KEY = 'home_featured_products_v1';
const FEATURED_PRODUCTS_CACHE_MAX_ITEMS = 40;

const readCachedFeaturedProducts = (): Product[] => {
  if (typeof window === 'undefined') {
    return [];
  }

  try {
    const raw = window.localStorage.getItem(FEATURED_PRODUCTS_CACHE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed as Product[];
  } catch {
    return [];
  }
};

const writeCachedFeaturedProducts = (items: Product[]) => {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    const limitedItems = items.slice(0, FEATURED_PRODUCTS_CACHE_MAX_ITEMS);
    window.localStorage.setItem(FEATURED_PRODUCTS_CACHE_KEY, JSON.stringify(limitedItems));
  } catch {
    // Ignore storage write errors (private mode, quota, etc.).
  }
};

const HomePage = () => {
  const navigate = useNavigate();
  const { openNeedPartModal } = useUI();
  const { addItem, decrement, getQuantity, increment, setQuantity } = useCart();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin' || user?.role === 'superadmin';
  const homeJsonLd = useMemo(
    () => [
      {
        '@context': 'https://schema.org',
        '@type': 'Organization',
        name: 'СТ-24',
        url: SITE_URL,
        logo: `${SITE_URL}/android-chrome-512x512.png`,
        email: 'st-karcher24@mail.ru',
        telephone: '+79959089597',
        sameAs: ['https://t.me/+79959089597'],
        contactPoint: [
          {
            '@type': 'ContactPoint',
            contactType: 'customer support',
            telephone: '+79959089597',
            email: 'st-karcher24@mail.ru',
            areaServed: 'RU',
            availableLanguage: ['ru']
          }
        ]
      },
      {
        '@context': 'https://schema.org',
        '@type': 'WebSite',
        name: 'СТ-24',
        url: SITE_URL
      }
    ],
    []
  );
  const sliderRef = useRef<HTMLDivElement | null>(null);
  const autoScrollTimeoutRef = useRef<number | null>(null);
  const programmaticUnlockTimeoutRef = useRef<number | null>(null);
  const loopResetTimeoutRef = useRef<number | null>(null);
  const isProgrammaticScrollRef = useRef(false);

  const [featuredProducts, setFeaturedProducts] = useState<Product[]>([]);
  const [homeBanner, setHomeBanner] = useState<HomeBanner | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');

  usePageSeo(
    'Купить запчасти для Karcher',
    'Купить запчасти для Karcher с доставкой по России. Оригинальные и аналоговые комплектующие от производителя.',
    {
      jsonLd: homeJsonLd
    }
  );

  useEffect(() => {
    let active = true;

    const load = async () => {
      try {
        const isTouchDevice =
          typeof window !== 'undefined' && window.matchMedia(TOUCH_DEVICE_QUERY).matches;
        const limit = isTouchDevice ? FEATURED_PRODUCTS_LIMIT_TOUCH : FEATURED_PRODUCTS_LIMIT_DESKTOP;
        const items = await fetchProducts({ featured: true, limit });
        if (!active) {
          return;
        }
        writeCachedFeaturedProducts(items);
        setFeaturedProducts(items);
        setStatus('ready');
      } catch {
        if (active) {
          const cachedItems = readCachedFeaturedProducts();
          if (cachedItems.length > 0) {
            setFeaturedProducts(cachedItems);
            setStatus('ready');
          } else {
            setStatus('error');
          }
        }
      }
    };

    load();

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;

    fetchHomeBanner()
      .then((banner) => {
        if (!active) {
          return;
        }
        setHomeBanner(banner);
      })
      .catch(() => {
        if (active) {
          setHomeBanner(null);
        }
      });

    return () => {
      active = false;
    };
  }, []);

  const clearAutoScrollTimeout = useCallback(() => {
    if (autoScrollTimeoutRef.current !== null) {
      window.clearTimeout(autoScrollTimeoutRef.current);
      autoScrollTimeoutRef.current = null;
    }
  }, []);

  const clearProgrammaticUnlockTimeout = useCallback(() => {
    if (programmaticUnlockTimeoutRef.current !== null) {
      window.clearTimeout(programmaticUnlockTimeoutRef.current);
      programmaticUnlockTimeoutRef.current = null;
    }
  }, []);

  const clearLoopResetTimeout = useCallback(() => {
    if (loopResetTimeoutRef.current !== null) {
      window.clearTimeout(loopResetTimeoutRef.current);
      loopResetTimeoutRef.current = null;
    }
  }, []);

  const lockProgrammaticScroll = useCallback(() => {
    isProgrammaticScrollRef.current = true;
    clearProgrammaticUnlockTimeout();

    programmaticUnlockTimeoutRef.current = window.setTimeout(() => {
      isProgrammaticScrollRef.current = false;
      programmaticUnlockTimeoutRef.current = null;
    }, PROGRAMMATIC_SCROLL_LOCK_MS);
  }, [clearProgrammaticUnlockTimeout]);

  const getSlideMetrics = useCallback((track: HTMLDivElement) => {
    const firstCard = track.querySelector<HTMLElement>('.slide');
    const styles = window.getComputedStyle(track);
    const gapValue = styles.columnGap || styles.gap || '0';
    const gap = Number.parseFloat(gapValue) || 0;
    const cardWidth = firstCard?.getBoundingClientRect().width ?? track.clientWidth;
    const step = cardWidth + gap;
    const visibleCards = step > 0 ? Math.max(1, Math.round((track.clientWidth + gap) / step)) : 1;
    return {
      cardStep: step,
      visibleCards
    };
  }, []);

  const resolveSlideLeftByIndex = useCallback(
    (track: HTMLDivElement, targetIndex: number, fallbackStep: number) => {
      const slides = track.querySelectorAll<HTMLElement>('.slide');
      const maxIndex = Math.max(0, slides.length - 1);
      const clampedIndex = Math.max(0, Math.min(targetIndex, maxIndex));
      const targetSlide = slides[clampedIndex];
      if (targetSlide) {
        return targetSlide.offsetLeft;
      }
      return clampedIndex * fallbackStep;
    },
    []
  );

  const loopCloneCount = useMemo(() => {
    if (featuredProducts.length <= AUTO_SCROLL_BATCH_SIZE) {
      return 0;
    }
    return Math.min(AUTO_SCROLL_BATCH_SIZE, featuredProducts.length);
  }, [featuredProducts.length]);

  const renderedFeaturedProducts = useMemo(() => {
    if (loopCloneCount === 0) {
      return featuredProducts;
    }
    return [...featuredProducts, ...featuredProducts.slice(0, loopCloneCount)];
  }, [featuredProducts, loopCloneCount]);

  const scheduleLoopReset = useCallback(() => {
    clearLoopResetTimeout();
    loopResetTimeoutRef.current = window.setTimeout(() => {
      const track = sliderRef.current;
      if (!track) {
        return;
      }
      isProgrammaticScrollRef.current = true;
      track.scrollTo({ left: 0 });
      lockProgrammaticScroll();
      loopResetTimeoutRef.current = null;
    }, LOOP_RESET_DELAY_MS);
  }, [clearLoopResetTimeout, lockProgrammaticScroll]);

  const handleAutoSlide = useCallback(() => {
    const track = sliderRef.current;
    if (!track) {
      return;
    }

    const realItemsCount = featuredProducts.length;
    if (realItemsCount === 0) {
      return;
    }

    const { cardStep, visibleCards } = getSlideMetrics(track);
    if (cardStep <= 0) {
      return;
    }

    const totalPages = Math.max(1, Math.ceil(realItemsCount / visibleCards));
    if (totalPages <= 1) {
      return;
    }

    const lastStartIndex = Math.max(0, (totalPages - 1) * visibleCards);
    const remainder = realItemsCount % visibleCards;
    const wrapStepCards = remainder === 0 ? visibleCards : remainder;
    const currentIndex = Math.round(track.scrollLeft / cardStep);

    clearLoopResetTimeout();
    lockProgrammaticScroll();

    if (currentIndex >= lastStartIndex) {
      if (loopCloneCount > 0) {
        const targetLeft = resolveSlideLeftByIndex(track, currentIndex + wrapStepCards, cardStep);
        track.scrollTo({
          left: targetLeft,
          behavior: 'smooth'
        });
        scheduleLoopReset();
        return;
      }

      track.scrollTo({ left: 0, behavior: 'smooth' });
      return;
    }

    const targetLeft = resolveSlideLeftByIndex(
      track,
      Math.min(currentIndex + visibleCards, lastStartIndex),
      cardStep
    );
    track.scrollTo({
      left: targetLeft,
      behavior: 'smooth'
    });
  }, [clearLoopResetTimeout, featuredProducts.length, getSlideMetrics, lockProgrammaticScroll, loopCloneCount, resolveSlideLeftByIndex, scheduleLoopReset]);

  const scheduleAutoScroll = useCallback(() => {
    clearAutoScrollTimeout();

    if (status !== 'ready') {
      return;
    }

    autoScrollTimeoutRef.current = window.setTimeout(() => {
      handleAutoSlide();
      scheduleAutoScroll();
    }, AUTO_SCROLL_INTERVAL_MS);
  }, [clearAutoScrollTimeout, handleAutoSlide, status]);

  const handleSlide = useCallback(
    (direction: 'prev' | 'next') => {
      const track = sliderRef.current;
      if (!track) {
        return;
      }

      const realItemsCount = featuredProducts.length;
      if (realItemsCount === 0) {
        return;
      }

      const { cardStep, visibleCards } = getSlideMetrics(track);
      if (cardStep <= 0) {
        return;
      }

      const totalPages = Math.max(1, Math.ceil(realItemsCount / visibleCards));
      const lastStartIndex = Math.max(0, (totalPages - 1) * visibleCards);
      const remainder = realItemsCount % visibleCards;
      const wrapStepCards = remainder === 0 ? visibleCards : remainder;
      const currentIndex = Math.round(track.scrollLeft / cardStep);

      clearLoopResetTimeout();
      lockProgrammaticScroll();

      if (direction === 'next') {
        if (currentIndex >= lastStartIndex) {
          if (loopCloneCount > 0) {
            const targetLeft = resolveSlideLeftByIndex(
              track,
              currentIndex + wrapStepCards,
              cardStep
            );
            track.scrollTo({
              left: targetLeft,
              behavior: 'smooth'
            });
            scheduleLoopReset();
          } else {
            track.scrollTo({ left: 0, behavior: 'smooth' });
          }
        } else {
          const targetLeft = resolveSlideLeftByIndex(
            track,
            Math.min(currentIndex + visibleCards, lastStartIndex),
            cardStep
          );
          track.scrollTo({
            left: targetLeft,
            behavior: 'smooth'
          });
        }
      } else if (currentIndex <= 0) {
        track.scrollTo({
          left: resolveSlideLeftByIndex(track, lastStartIndex, cardStep),
          behavior: 'smooth'
        });
      } else if (currentIndex > lastStartIndex) {
        track.scrollTo({
          left: resolveSlideLeftByIndex(track, lastStartIndex, cardStep),
          behavior: 'smooth'
        });
      } else {
        const targetLeft = resolveSlideLeftByIndex(
          track,
          Math.max(0, currentIndex - visibleCards),
          cardStep
        );
        track.scrollTo({
          left: targetLeft,
          behavior: 'smooth'
        });
      }

      scheduleAutoScroll();
    },
    [clearLoopResetTimeout, featuredProducts.length, getSlideMetrics, lockProgrammaticScroll, loopCloneCount, resolveSlideLeftByIndex, scheduleAutoScroll, scheduleLoopReset]
  );

  useEffect(() => {
    scheduleAutoScroll();
    return () => {
      clearAutoScrollTimeout();
    };
  }, [clearAutoScrollTimeout, scheduleAutoScroll]);

  useEffect(() => {
    const track = sliderRef.current;
    if (!track) {
      return;
    }

    const handleTrackScroll = () => {
      if (isProgrammaticScrollRef.current) {
        return;
      }
      clearLoopResetTimeout();
      scheduleAutoScroll();
    };

    track.addEventListener('scroll', handleTrackScroll, { passive: true });
    return () => {
      track.removeEventListener('scroll', handleTrackScroll);
    };
  }, [clearLoopResetTimeout, scheduleAutoScroll]);

  useEffect(() => {
    const handleResize = () => {
      clearLoopResetTimeout();
      scheduleAutoScroll();
    };

    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, [clearLoopResetTimeout, scheduleAutoScroll]);

  useEffect(
    () => () => {
      clearProgrammaticUnlockTimeout();
      clearLoopResetTimeout();
      clearAutoScrollTimeout();
    },
    [clearAutoScrollTimeout, clearLoopResetTimeout, clearProgrammaticUnlockTimeout]
  );

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
      navigate(`/product/${product.id}`);
    },
    [navigate]
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
      <div className="slider-header">
        <div>
          <h1>Запчасти для аппаратов от СТ-24</h1>
        </div>
      </div>

      <picture className="home-banner">
        <source
          media={MOBILE_BANNER_MEDIA_QUERY}
          srcSet={homeBanner?.mobileImage ?? FALLBACK_MOBILE_BANNER}
        />
        <img
          src={homeBanner?.desktopImage ?? FALLBACK_DESKTOP_BANNER}
          alt=""
          aria-hidden="true"
        />
      </picture>

      <div className="slider-controls home-slider-controls">
        <a
          href="#featured-slider"
          className="slider-link"
          onClick={(event) => {
            event.preventDefault();
            handleSlide('prev');
          }}
        >
          {'назад'}
        </a>
        <a
          href="#featured-slider"
          className="slider-link"
          onClick={(event) => {
            event.preventDefault();
            handleSlide('next');
          }}
        >
          {'вперёд'}
        </a>
      </div>

      {status === 'loading' && <p className="muted">{'Загружаем товары...'}</p>}
      {status === 'error' && <p className="muted">{'Не получилось загрузить товары.'}</p>}
      {status === 'ready' && featuredProducts.length === 0 && (
        <p className="muted">{'Пока нет товаров для слайдера. Отметьте товары в админке.'}</p>
      )}
      {status === 'ready' && renderedFeaturedProducts.length > 0 && (
        <div id="featured-slider" className="slider-track" ref={sliderRef}>
          {renderedFeaturedProducts.map((product, index) => (
            <ProductMiniCard
              key={`${product.id}-${index}`}
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

      <div className="home-actions">
        <Link to="/catalog/zapchasti-dlya-professionalnyh-apparatov" className="primary-button">
          {'Проф. запчасти'}
        </Link>
        <Link to="/catalog/zapchasti-dlya-bytovyh-apparatov" className="ghost-button">
          {'Бытовые'}
        </Link>
      </div>
    </div>
  );
};

export default HomePage;

