import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { searchProductsBySku } from '../api';
import type { Product } from '../api';

const SEARCH_PREVIEW_LIMIT = 8;
const SEARCH_PREVIEW_VISIBLE = 7;
const SEARCH_DEBOUNCE_MS = 250;
const MIN_SEARCH_SYMBOLS = 2;

const normalizeSkuQuery = (value: string) => value.replace(/[^0-9a-zа-яё]/giu, '');

type HeaderSkuSearchProps = {
  className?: string;
};

const HeaderSkuSearch = ({ className }: HeaderSkuSearchProps) => {
  const navigate = useNavigate();
  const location = useLocation();
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  const [query, setQuery] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [results, setResults] = useState<Product[]>([]);
  const [total, setTotal] = useState(0);
  const [usedFallback, setUsedFallback] = useState(false);
  const [fallbackPrefix, setFallbackPrefix] = useState<string | null>(null);

  const normalizedQuery = useMemo(() => normalizeSkuQuery(query), [query]);

  useEffect(() => {
    if (location.pathname !== '/search') {
      return;
    }
    const params = new URLSearchParams(location.search);
    const nextQuery = (params.get('q') ?? '').trim();
    setQuery(nextQuery);
  }, [location.pathname, location.search]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handleDocumentClick = (event: MouseEvent) => {
      if (!wrapperRef.current) {
        return;
      }
      if (wrapperRef.current.contains(event.target as Node)) {
        return;
      }
      setIsOpen(false);
    };

    document.addEventListener('mousedown', handleDocumentClick);
    return () => {
      document.removeEventListener('mousedown', handleDocumentClick);
    };
  }, [isOpen]);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setStatus('idle');
      setResults([]);
      setTotal(0);
      setUsedFallback(false);
      setFallbackPrefix(null);
      return;
    }

    if (normalizedQuery.length < MIN_SEARCH_SYMBOLS) {
      setStatus('idle');
      setResults([]);
      setTotal(0);
      setUsedFallback(false);
      setFallbackPrefix(null);
      return;
    }

    let active = true;
    setStatus('loading');

    const timeout = window.setTimeout(() => {
      searchProductsBySku(trimmed, SEARCH_PREVIEW_LIMIT)
        .then((response) => {
          if (!active) {
            return;
          }
          setResults(response.items);
          setTotal(response.total);
          setUsedFallback(response.usedFallback);
          setFallbackPrefix(response.fallbackPrefix);
          setStatus('ready');
        })
        .catch(() => {
          if (!active) {
            return;
          }
          setStatus('error');
          setResults([]);
          setTotal(0);
          setUsedFallback(false);
          setFallbackPrefix(null);
        });
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      active = false;
      window.clearTimeout(timeout);
    };
  }, [normalizedQuery, query]);

  const openSearchPage = (value: string) => {
    const nextQuery = value.trim();
    if (!nextQuery) {
      return;
    }
    navigate(`/search?q=${encodeURIComponent(nextQuery)}`);
    setIsOpen(false);
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    openSearchPage(query);
  };

  const showDropdown =
    isOpen &&
    Boolean(query.trim()) &&
    (status !== 'idle' || normalizedQuery.length < MIN_SEARCH_SYMBOLS);

  return (
    <div className={className} ref={wrapperRef}>
      <form className="header-search-form" onSubmit={handleSubmit}>
        <input
          type="search"
          className="header-search-input"
          placeholder="Поиск по артикулу (SKU)"
          value={query}
          onFocus={() => setIsOpen(true)}
          onChange={(event) => {
            setQuery(event.target.value);
            setIsOpen(true);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setIsOpen(false);
            }
          }}
          aria-label="Поиск товара по артикулу"
          autoComplete="off"
        />
        <button type="submit" className="header-search-submit">
          Найти
        </button>
      </form>

      {showDropdown && (
        <div className="header-search-dropdown" role="listbox" aria-label="Результаты поиска">
          {normalizedQuery.length < MIN_SEARCH_SYMBOLS && (
            <p className="header-search-status">Введите минимум 2 символа артикула.</p>
          )}
          {status === 'loading' && <p className="header-search-status">Ищем товары...</p>}
          {status === 'error' && (
            <p className="header-search-status header-search-status--error">
              Не удалось выполнить поиск.
            </p>
          )}
          {status === 'ready' && (
            <>
              {results.length === 0 ? (
                <p className="header-search-status">Ничего не найдено.</p>
              ) : (
                <ul className="header-search-list">
                  {results.slice(0, SEARCH_PREVIEW_VISIBLE).map((item) => (
                    <li key={item.id}>
                      <button
                        type="button"
                        className="header-search-item"
                        onClick={() => openSearchPage(item.sku)}
                      >
                        <span className="header-search-item-text">
                          <span className="header-search-item-title">{item.name}</span>
                          <span className="header-search-item-sku">{item.sku}</span>
                        </span>
                        <span className="header-search-item-thumb" aria-hidden="true">
                          {item.images[0] ? <img src={item.images[0]} alt="" /> : null}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {usedFallback && (
                <p className="header-search-note">
                  Точных совпадений нет. Показаны товары по первым 4 цифрам
                  {fallbackPrefix ? `: ${fallbackPrefix}` : ''}.
                </p>
              )}
              {total > SEARCH_PREVIEW_VISIBLE && (
                <button
                  type="button"
                  className="link-button header-search-all"
                  onClick={() => openSearchPage(query)}
                >
                  Все результаты
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
};

export default HeaderSkuSearch;
