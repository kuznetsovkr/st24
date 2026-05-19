import { Suspense, lazy, type ComponentType } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import AppLayout from './layout/AppLayout.tsx';
import { AuthProvider } from './context/AuthContext.tsx';
import { CartProvider } from './context/CartContext.tsx';
import { UIProvider } from './context/UIContext.tsx';
// import ProductQuickViewModal from './components/ProductQuickViewModal.tsx';
import AuthModal from './components/AuthModal.tsx';
import NeedPartModal from './components/NeedPartModal.tsx';
import RouteErrorBoundary from './components/RouteErrorBoundary.tsx';
import HomePage from './pages/Home.tsx';

const ROUTE_CHUNK_TIMEOUT_MS = 15000;

type LazyRouteModule = {
  default: ComponentType;
};

const lazyRoute = (loader: () => Promise<LazyRouteModule>) =>
  lazy(async () => {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    try {
      return await Promise.race([
        loader(),
        new Promise<never>((_resolve, reject) => {
          timeoutId = setTimeout(() => {
            reject(new Error(`Route chunk load timeout (${ROUTE_CHUNK_TIMEOUT_MS} ms)`));
          }, ROUTE_CHUNK_TIMEOUT_MS);
        })
      ]);
    } finally {
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
      }
    }
  });

const ContactsPage = lazyRoute(() => import('./pages/Contacts.tsx'));
const AboutPage = lazyRoute(() => import('./pages/About.tsx'));
const AdminPage = lazyRoute(() => import('./pages/Admin.tsx'));
const B2BPage = lazyRoute(() => import('./pages/B2B.tsx'));
const CartPage = lazyRoute(() => import('./pages/Cart.tsx'));
const CatalogPage = lazyRoute(() => import('./pages/Catalog.tsx'));
const CategoryPage = lazyRoute(() => import('./pages/Category.tsx'));
const AccountPage = lazyRoute(() => import('./pages/Account.tsx'));
const CheckoutPage = lazyRoute(() => import('./pages/Checkout.tsx'));
const NotFoundPage = lazyRoute(() => import('./pages/NotFound.tsx'));
const OrderSuccessPage = lazyRoute(() => import('./pages/OrderSuccess.tsx'));
const PaymentPage = lazyRoute(() => import('./pages/Payment.tsx'));
const ProductPage = lazyRoute(() => import('./pages/Product.tsx'));
const SearchPage = lazyRoute(() => import('./pages/Search.tsx'));
const PrivacyPage = lazyRoute(() => import('./pages/Privacy.tsx'));
const TermsPage = lazyRoute(() => import('./pages/Terms.tsx'));
const ConsentPage = lazyRoute(() => import('./pages/Consent.tsx'));

const RouteLoader = () => (
  <div className="page">
    <p className="muted">{'Загружаем страницу...'}</p>
  </div>
);

const App = () => (
  <BrowserRouter>
    <AuthProvider>
      <CartProvider>
        <UIProvider>
          <AppLayout>
            <RouteErrorBoundary>
              <Suspense fallback={<RouteLoader />}>
                <Routes>
                  <Route path="/" element={<HomePage />} />
                  <Route path="/catalog" element={<CatalogPage />} />
                  <Route path="/catalog/:slug" element={<CategoryPage />} />
                  <Route path="/cart" element={<CartPage />} />
                  <Route path="/checkout" element={<CheckoutPage />} />
                  <Route path="/search" element={<SearchPage />} />
                  <Route path="/payment/:orderId" element={<PaymentPage />} />
                  <Route path="/product/:id" element={<ProductPage />} />
                  <Route path="/order-success/:orderId" element={<OrderSuccessPage />} />
                  <Route path="/contacts" element={<ContactsPage />} />
                  <Route path="/about" element={<AboutPage />} />
                  <Route path="/b2b" element={<B2BPage />} />
                  <Route path="/privacy" element={<PrivacyPage />} />
                  <Route path="/terms" element={<TermsPage />} />
                  <Route path="/consent" element={<ConsentPage />} />
                  <Route path="/account" element={<AccountPage />} />
                  <Route path="/admin" element={<AdminPage />} />
                  <Route path="*" element={<NotFoundPage />} />
                </Routes>
              </Suspense>
            </RouteErrorBoundary>
            {/* <ProductQuickViewModal /> */}
            <AuthModal />
            <NeedPartModal />
          </AppLayout>
        </UIProvider>
      </CartProvider>
    </AuthProvider>
  </BrowserRouter>
);

export default App;
