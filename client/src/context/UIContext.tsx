import { createContext, useContext, useState } from 'react';
import type { ReactNode } from 'react';

type ProductPreview = {
  id: string;
  name: string;
  priceCents: number;
  description?: string;
  image?: string;
  sku?: string;
  stock?: number;
};

type ProductModalState = {
  open: boolean;
  product?: ProductPreview;
};

type UIContextValue = {
  authModalOpen: boolean;
  productModal: ProductModalState;
  openAuthModal: () => void;
  closeAuthModal: () => void;
  openProductModal: (product: ProductPreview) => void;
  closeProductModal: () => void;
};

const UIContext = createContext<UIContextValue | undefined>(undefined);

export const UIProvider = ({ children }: { children: ReactNode }) => {
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [productModal, setProductModal] = useState<ProductModalState>({ open: false });

  const value: UIContextValue = {
    authModalOpen,
    productModal,
    openAuthModal: () => setAuthModalOpen(true),
    closeAuthModal: () => setAuthModalOpen(false),
    openProductModal: (product: ProductPreview) => setProductModal({ open: true, product }),
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
