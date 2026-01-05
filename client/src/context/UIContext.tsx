import { createContext, useContext, useState } from 'react';
import type { ReactNode } from 'react';

type ProductModalState = {
  open: boolean;
  productName?: string;
};

type UIContextValue = {
  authModalOpen: boolean;
  cartCount: number;
  productModal: ProductModalState;
  openAuthModal: () => void;
  closeAuthModal: () => void;
  incrementCart: () => void;
  openProductModal: (productName?: string) => void;
  closeProductModal: () => void;
};

const UIContext = createContext<UIContextValue | undefined>(undefined);

export const UIProvider = ({ children }: { children: ReactNode }) => {
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [cartCount, setCartCount] = useState(0);
  const [productModal, setProductModal] = useState<ProductModalState>({ open: false });

  const value: UIContextValue = {
    authModalOpen,
    cartCount,
    productModal,
    openAuthModal: () => setAuthModalOpen(true),
    closeAuthModal: () => setAuthModalOpen(false),
    incrementCart: () => setCartCount((prev) => prev + 1),
    openProductModal: (productName?: string) => setProductModal({ open: true, productName }),
    closeProductModal: () => setProductModal({ open: false })
  };

  return <UIContext.Provider value={value}>{children}</UIContext.Provider>;
};

export const useUI = () => {
  const ctx = useContext(UIContext);

  if (!ctx) {
    throw new Error('useUI must be used within a UIProvider');
  }

  return ctx;
};
