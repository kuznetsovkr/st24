import { useRef } from 'react';

type ProductImageSliderProps = {
  images?: string[];
  alt: string;
  className?: string;
};

const ProductImageSlider = ({ images = [], alt, className }: ProductImageSliderProps) => {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const slides = images.filter(Boolean);
  const hasSlides = slides.length > 0;
  const canSlide = slides.length > 1;

  const handleSlide = (direction: 'prev' | 'next') => {
    const track = trackRef.current;
    if (!track) {
      return;
    }
    const firstSlide = track.querySelector<HTMLElement>('.product-image-slide');
    const styles = window.getComputedStyle(track);
    const gapValue = styles.columnGap || styles.gap || '0';
    const gap = Number.parseFloat(gapValue) || 0;
    const slideWidth = firstSlide?.getBoundingClientRect().width ?? track.clientWidth;
    const offset = slideWidth + gap;
    track.scrollBy({
      left: direction === 'next' ? offset : -offset,
      behavior: 'smooth'
    });
  };

  return (
    <div className={`${className ?? ''} product-image-slider`.trim()}>
      {hasSlides ? (
        <div className="product-image-track" ref={trackRef}>
          {slides.map((src, index) => (
            <div className="product-image-slide" key={`${src}-${index}`}>
              <img src={src} alt={`${alt} ${index + 1}`} loading="lazy" />
            </div>
          ))}
        </div>
      ) : (
        <span>Фото</span>
      )}
      {canSlide && (
        <div className="product-image-controls">
          <button
            type="button"
            className="product-image-control"
            aria-label="Предыдущее фото"
            onClick={(event) => {
              event.stopPropagation();
              handleSlide('prev');
            }}
          >
            {'<'}
          </button>
          <button
            type="button"
            className="product-image-control"
            aria-label="Следующее фото"
            onClick={(event) => {
              event.stopPropagation();
              handleSlide('next');
            }}
          >
            {'>'}
          </button>
        </div>
      )}
    </div>
  );
};

export default ProductImageSlider;
