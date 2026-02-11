import { useEffect, useState } from 'react';
import type { MouseEvent } from 'react';

type ProductImageSliderProps = {
  images?: string[];
  alt: string;
  className?: string;
};

const ProductImageSlider = ({ images = [], alt, className }: ProductImageSliderProps) => {
  const slides = images.filter(Boolean);
  const hasSlides = slides.length > 0;
  const canSlide = slides.length > 1;
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    setActiveIndex(0);
  }, [slides.join('|')]);

  useEffect(() => {
    if (activeIndex >= slides.length) {
      setActiveIndex(0);
    }
  }, [activeIndex, slides.length]);

  const showIndex = (index: number) => {
    if (!slides.length) {
      return;
    }
    const nextIndex = (index + slides.length) % slides.length;
    setActiveIndex(nextIndex);
  };

  const handlePrev = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    showIndex(activeIndex - 1);
  };

  const handleNext = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    showIndex(activeIndex + 1);
  };

  const handleHover = (event: MouseEvent<HTMLDivElement>) => {
    if (!canSlide) {
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    if (!rect.width) {
      return;
    }
    const x = event.clientX - rect.left;
    const ratio = x / rect.width;
    const index = Math.min(slides.length - 1, Math.max(0, Math.floor(ratio * slides.length)));
    setActiveIndex((prev) => (prev === index ? prev : index));
  };

  const activeSrc = slides[activeIndex];

  return (
    <div className="product-image-slider">
      <div className={`${className ?? ''} product-image-frame`.trim()}>
        {hasSlides ? (
          <>
            <img src={activeSrc} alt={`${alt} ${activeIndex + 1}`} loading="lazy" />
            {canSlide && (
              <div
                className="product-image-hotspots"
                onMouseMove={handleHover}
                onMouseEnter={handleHover}
                aria-hidden="true"
              />
            )}
          </>
        ) : (
          <span>Фото</span>
        )}
      </div>
      {canSlide && (
        <div className="product-image-controls">
          <button
            type="button"
            className="product-image-arrow"
            aria-label="Предыдущее фото"
            onClick={handlePrev}
          >
            {'<'}
          </button>
          <div className="product-image-dots">
            {slides.map((_, index) => (
              <button
                key={`dot-${index}`}
                type="button"
                className={`product-image-dot${index === activeIndex ? ' is-active' : ''}`}
                aria-label={`Фото ${index + 1}`}
                onClick={(event) => {
                  event.stopPropagation();
                  showIndex(index);
                }}
              />
            ))}
          </div>
          <button
            type="button"
            className="product-image-arrow"
            aria-label="Следующее фото"
            onClick={handleNext}
          >
            {'>'}
          </button>
        </div>
      )}
    </div>
  );
};

export default ProductImageSlider;
