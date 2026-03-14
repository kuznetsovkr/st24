import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { fetchCart, mergeCart, syncCart } from '../api.ts';

export type CartItem = {
  id: string;
  name: string;
  priceCents: number;
  image?: string | null;
  stock?: number;
  weightGrams?: number;
  lengthCm?: number;
  widthCm?: number;
  heightCm?: number;
};

export type CartEntry = CartItem & {
  quantity: number;
};

type CartContextValue = {
  items: CartEntry[];
  addItem: (item: CartItem, quantity?: number) => void;
  increment: (id: string) => void;
  decrement: (id: string) => void;
  setQuantity: (id: string, quantity: number) => void;
  removeItem: (id: string) => void;
  clear: () => void;
  getQuantity: (id: string) => number;
  mergeWithServer: () => Promise<void>;
  refreshFromServer: () => Promise<CartEntry[]>;
  syncWithServer: () => Promise<CartEntry[]>;
  totalCount: number;
  totalPriceCents: number;
};

const CartContext = createContext<CartContextValue | undefined>(undefined);
const STORAGE_KEY = 'her_cart_v1';
const CSRF_COOKIE_NAME = 'her_csrf_token';

const hasCsrfCookie = () => {
  if (typeof document === 'undefined') {
    return false;
  }

  return document.cookie
    .split(';')
    .some((part) => part.trim().startsWith(`${CSRF_COOKIE_NAME}=`));
};

const loadCart = (): CartEntry[] => {
  if (typeof window === 'undefined') {
    return [];
  }

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as CartEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

export const CartProvider = ({ children }: { children: ReactNode }) => {
  const [items, setItems] = useState<CartEntry[]>(() => loadCart());
  const [hydrated, setHydrated] = useState(false);
  const [hasServerSession, setHasServerSession] = useState(false);
  const skipNextSync = useRef(true);
  const syncTimeout = useRef<number | null>(null);

  const toSyncPayload = (entries: CartEntry[]) =>
    entries.map((entry) => ({ productId: entry.id, quantity: entry.quantity }));

  const clampQuantity = (entry: CartEntry, nextQuantity: number) => {
    if (typeof entry.stock === 'number') {
      if (nextQuantity <= entry.stock) {
        return nextQuantity;
      }
      if (entry.quantity > entry.stock) {
        return entry.quantity;
      }
      return entry.stock;
    }
    return nextQuantity;
  };

  useEffect(() => {
    if (!hasCsrfCookie()) {
      setHasServerSession(false);
      setHydrated(true);
      return;
    }

    let active = true;
    fetchCart()
      .then((serverItems) => {
        if (!active) {
          return;
        }
        setHasServerSession(true);
        skipNextSync.current = true;
        setItems(serverItems);
      })
      .catch(() => {
        if (!active) {
          return;
        }
        setHasServerSession(false);
      })
      .finally(() => {
        if (active) {
          setHydrated(true);
        }
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  }, [items]);

  useEffect(() => {
    if (!hydrated) {
      return;
    }

    if (!hasServerSession || !hasCsrfCookie()) {
      return;
    }

    if (skipNextSync.current) {
      skipNextSync.current = false;
      return;
    }

    if (syncTimeout.current) {
      window.clearTimeout(syncTimeout.current);
    }

    syncTimeout.current = window.setTimeout(() => {
      syncCart(toSyncPayload(items)).catch(() => {
        setHasServerSession(false);
      });
    }, 400);

    return () => {
      if (syncTimeout.current) {
        window.clearTimeout(syncTimeout.current);
      }
    };
  }, [hydrated, hasServerSession, items]);

  const addItem = (item: CartItem, quantity = 1) => {
    if (quantity <= 0) {
      return;
    }
    setItems((prev) => {
      const existing = prev.find((entry) => entry.id === item.id);
      if (!existing) {
        const nextQuantity =
          typeof item.stock === 'number' ? Math.min(quantity, item.stock) : quantity;
        if (nextQuantity <= 0) {
          return prev;
        }
        return [...prev, { ...item, quantity: nextQuantity }];
      }
      return prev.map((entry) => {
        if (entry.id !== item.id) {
          return entry;
        }
        const nextEntry =
          typeof entry.stock === 'number' ? entry : { ...entry, stock: item.stock };
        const nextQuantity = clampQuantity(nextEntry, entry.quantity + quantity);
        return { ...nextEntry, quantity: nextQuantity };
      });
    });
  };

  const setQuantity = (id: string, quantity: number) => {
    if (quantity <= 0) {
      setItems((prev) => prev.filter((entry) => entry.id !== id));
      return;
    }

    setItems((prev) =>
      prev.map((entry) => (entry.id === id ? { ...entry, quantity } : entry))
    );
  };

  const increment = (id: string) => {
    setItems((prev) =>
      prev.map((entry) =>
        entry.id === id
          ? { ...entry, quantity: clampQuantity(entry, entry.quantity + 1) }
          : entry
      )
    );
  };

  const decrement = (id: string) => {
    setItems((prev) =>
      prev
        .map((entry) =>
          entry.id === id ? { ...entry, quantity: entry.quantity - 1 } : entry
        )
        .filter((entry) => entry.quantity > 0)
    );
  };

  const removeItem = (id: string) => {
    setItems((prev) => prev.filter((entry) => entry.id !== id));
  };

  const clear = () => setItems([]);

  const getQuantity = (id: string) => items.find((entry) => entry.id === id)?.quantity ?? 0;

  const mergeWithServer = async () => {
    if (!hasCsrfCookie()) {
      setHasServerSession(false);
      setHydrated(true);
      return;
    }

    try {
      const merged = await mergeCart(toSyncPayload(items));
      setHasServerSession(true);
      skipNextSync.current = true;
      setItems(merged);
    } catch {
      setHasServerSession(false);
      // ignore sync errors to keep local cart usable
    } finally {
      setHydrated(true);
    }
  };

  const refreshFromServer = async () => {
    if (!hasServerSession || !hasCsrfCookie()) {
      return items;
    }

    try {
      const serverItems = await fetchCart();
      setHasServerSession(true);
      skipNextSync.current = true;
      setItems(serverItems);
      return serverItems;
    } catch {
      setHasServerSession(false);
      return items;
    }
  };

  const syncWithServer = async () => {
    if (!hasServerSession || !hasCsrfCookie()) {
      return items;
    }

    try {
      const synced = await syncCart(toSyncPayload(items));
      setHasServerSession(true);
      skipNextSync.current = true;
      setItems(synced);
      return synced;
    } catch {
      setHasServerSession(false);
      return items;
    }
  };

  const totals = useMemo(() => {
    const totalCount = items.reduce((sum, entry) => sum + entry.quantity, 0);
    const totalPriceCents = items.reduce(
      (sum, entry) => sum + entry.quantity * entry.priceCents,
      0
    );
    return { totalCount, totalPriceCents };
  }, [items]);

  const value: CartContextValue = {
    items,
    addItem,
    increment,
    decrement,
    setQuantity,
    removeItem,
    clear,
    getQuantity,
    mergeWithServer,
    refreshFromServer,
    syncWithServer,
    totalCount: totals.totalCount,
    totalPriceCents: totals.totalPriceCents
  };

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
};

export const useCart = () => {
  const ctx = useContext(CartContext);
  if (!ctx) {
    throw new Error('useCart must be used within a CartProvider');
  }
  return ctx;
};
