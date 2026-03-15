import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchHomeBanner, fetchProducts } from '../api';
import type { HomeBanner, Product } from '../api';
import ProductMiniCard from '../components/ProductMiniCard.tsx';
import { useAuth } from '../context/AuthContext.tsx';
import { useCart } from '../context/CartContext.tsx';
import { useUI } from '../context/UIContext.tsx';

const AUTO_SCROLL_INTERVAL_MS = 10000;
const AUTO_SCROLL_BATCH_SIZE = 5;
const PROGRAMMATIC_SCROLL_LOCK_MS = 450;
const LOOP_RESET_DELAY_MS = 520;
const FALLBACK_DESKTOP_BANNER = '/banners/16_9.png';
const FALLBACK_MOBILE_BANNER = '/banners/4_3.png';

const HomePage = () => {
  const { openProductModal, openNeedPartModal } = useUI();
  const { addItem, decrement, getQuantity, increment, setQuantity } = useCart();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';

  const sliderRef = useRef<HTMLDivElement | null>(null);
  const autoScrollTimeoutRef = useRef<number | null>(null);
  const programmaticUnlockTimeoutRef = useRef<number | null>(null);
  const loopResetTimeoutRef = useRef<number | null>(null);
  const isProgrammaticScrollRef = useRef(false);

  const [featuredProducts, setFeaturedProducts] = useState<Product[]>([]);
  const [homeBanner, setHomeBanner] = useState<HomeBanner | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    let active = true;

    const load = async () => {
      try {
        const items = await fetchProducts({ featured: true, limit: 120 });
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
      <div className="slider-header">
        <div>
          <h1>{'\u041f\u043e\u0434\u0431\u043e\u0440\u043a\u0430 \u0442\u043e\u0432\u0430\u0440\u043e\u0432'}</h1>
        </div>
      </div>

      <picture className="home-banner">
        <source
          media="(max-width: 700px)"
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
          {'\u043d\u0430\u0437\u0430\u0434'}
        </a>
        <a
          href="#featured-slider"
          className="slider-link"
          onClick={(event) => {
            event.preventDefault();
            handleSlide('next');
          }}
        >
          {'\u0432\u043f\u0435\u0440\u0451\u0434'}
        </a>
      </div>

      {status === 'loading' && <p className="muted">{'\u0417\u0430\u0433\u0440\u0443\u0436\u0430\u0435\u043c \u0442\u043e\u0432\u0430\u0440\u044b...'}</p>}
      {status === 'error' && <p className="muted">{'\u041d\u0435 \u043f\u043e\u043b\u0443\u0447\u0438\u043b\u043e\u0441\u044c \u0437\u0430\u0433\u0440\u0443\u0437\u0438\u0442\u044c \u0442\u043e\u0432\u0430\u0440\u044b.'}</p>}
      {status === 'ready' && featuredProducts.length === 0 && (
        <p className="muted">{'\u041f\u043e\u043a\u0430 \u043d\u0435\u0442 \u0442\u043e\u0432\u0430\u0440\u043e\u0432 \u0434\u043b\u044f \u0441\u043b\u0430\u0439\u0434\u0435\u0440\u0430. \u041e\u0442\u043c\u0435\u0442\u044c\u0442\u0435 \u0442\u043e\u0432\u0430\u0440\u044b \u0432 \u0430\u0434\u043c\u0438\u043d\u043a\u0435.'}</p>
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
        <Link to="/catalog/prof-zapchasti" className="primary-button">
          {'\u041f\u0440\u043e\u0444. \u0437\u0430\u043f\u0447\u0430\u0441\u0442\u0438'}
        </Link>
        <Link to="/catalog/bytovye" className="ghost-button">
          {'\u0411\u044b\u0442\u043e\u0432\u044b\u0435'}
        </Link>
      </div>
    </div>
  );
};

export default HomePage;
