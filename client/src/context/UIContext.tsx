import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

type ProductPreview = {
  id: string;
  name: string;
  priceCents: number;
  description?: string;
  image?: string;
  images?: string[];
  sku?: string;
  stock?: number;
  weightGrams?: number;
  lengthCm?: number;
  widthCm?: number;
  heightCm?: number;
};

type ProductModalState = {
  open: boolean;
  product?: ProductPreview;
};

type NeedPartModalState = {
  open: boolean;
  product?: ProductPreview;
};

type UIContextValue = {
  authModalOpen: boolean;
  productModal: ProductModalState;
  needPartModal: NeedPartModalState;
  openAuthModal: () => void;
  closeAuthModal: () => void;
  openProductModal: (product: ProductPreview) => void;
  closeProductModal: () => void;
  openNeedPartModal: (product: ProductPreview) => void;
  closeNeedPartModal: () => void;
};

const UIContext = createContext<UIContextValue | undefined>(undefined);

export const UIProvider = ({ children }: { children: ReactNode }) => {
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [productModal, setProductModal] = useState<ProductModalState>({ open: false });
  const [needPartModal, setNeedPartModal] = useState<NeedPartModalState>({ open: false });

  const openAuthModal = useCallback(() => {
    setAuthModalOpen(true);
  }, []);

  const closeAuthModal = useCallback(() => {
    setAuthModalOpen(false);
  }, []);

  const openProductModal = useCallback((product: ProductPreview) => {
    setProductModal({ open: true, product });
  }, []);

  const closeProductModal = useCallback(() => {
    setProductModal({ open: false });
  }, []);

  const openNeedPartModal = useCallback((product: ProductPreview) => {
    setNeedPartModal({ open: true, product });
  }, []);

  const closeNeedPartModal = useCallback(() => {
    setNeedPartModal({ open: false });
  }, []);

  const value = useMemo<UIContextValue>(
    () => ({
      authModalOpen,
      productModal,
      needPartModal,
      openAuthModal,
      closeAuthModal,
      openProductModal,
      closeProductModal,
      openNeedPartModal,
      closeNeedPartModal
    }),
    [
      authModalOpen,
      productModal,
      needPartModal,
      openAuthModal,
      closeAuthModal,
      openProductModal,
      closeProductModal,
      openNeedPartModal,
      closeNeedPartModal
    ]
  );

  return <UIContext.Provider value={value}>{children}</UIContext.Provider>;
};

export const useUI = () => {
  const ctx = useContext(UIContext);

  if (!ctx) {
    throw new Error('useUI must be used within a UIProvider');
  }

  return ctx;
};
