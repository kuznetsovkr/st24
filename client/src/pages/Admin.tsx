import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChangeEvent, DragEvent, FormEvent } from 'react';
import {
  createBoxType,
  clearAuthToken,
  createProduct,
  deleteCategorySection,
  deleteBoxType,
  deleteProduct,
  fetchBoxTypes,
  fetchCategories,
  fetchDeliveryProviders,
  fetchHomeBanner,
  fetchMe,
  fetchProducts,
  getAuthToken,
  requestAuthCode,
  setAuthToken,
  updateCategorySection,
  updateDeliveryProvider,
  updateHomeBanner,
  updateBoxType,
  updateProduct,
  verifyAuthCode
} from '../api';
import type {
  AuthUser,
  BoxType,
  Category,
  DeliveryProviderSetting,
  HomeBanner,
  Product
} from '../api';
import TurnstileWidget from '../components/TurnstileWidget.tsx';
import {
  applyFontTheme,
  getStoredFontTheme,
  setStoredFontTheme,
  type FontTheme
} from '../utils/fontTheme';

const MAX_IMAGES = 5;
const getPhoneDigits = (value: string) => value.replace(/\D/g, '');
const isPhoneReadyForCaptcha = (value: string) => {
  const digits = getPhoneDigits(value);
  return digits.length === 11 && (digits.startsWith('7') || digits.startsWith('8'));
};

const readFileAsDataUrl = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Не удалось прочитать файл'));
    reader.readAsDataURL(file);
  });

const copyFileToMemory = async (file: File) => {
  const buffer = await file.arrayBuffer();
  return new File([buffer], file.name, { type: file.type, lastModified: file.lastModified });
};

const moveItem = <T,>(items: T[], from: number, to: number) => {
  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
};

const getImageName = (value: string) => {
  const trimmed = value.split('?')[0];
  const parts = trimmed.split('/');
  return parts[parts.length - 1] || trimmed;
};

type CategorySectionEditorState = {
  name: string;
  slug: string;
  imageFile: File | null;
  imagePreview: string | null;
  removeImage: boolean;
  isSubmitting: boolean;
  status: string | null;
  error: string | null;
};

const CYRILLIC_TO_LATIN_MAP: Record<string, string> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  ё: 'e',
  ж: 'zh',
  з: 'z',
  и: 'i',
  й: 'i',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'h',
  ц: 'c',
  ч: 'ch',
  ш: 'sh',
  щ: 'sch',
  ъ: '',
  ы: 'y',
  ь: '',
  э: 'e',
  ю: 'yu',
  я: 'ya'
};

const transliterateToLatin = (value: string) =>
  value
    .split('')
    .map((char) => CYRILLIC_TO_LATIN_MAP[char] ?? char)
    .join('');

const toCategorySlug = (value: string) =>
  transliterateToLatin(value.toLowerCase())
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');

const getApiErrorMessage = (message: string) => {
  if (!message) {
    return '';
  }
  const trimmed = message.trim();
  if (!(trimmed.startsWith('{') && trimmed.endsWith('}'))) {
    return message;
  }
  try {
    const parsed = JSON.parse(trimmed) as { error?: string; message?: string };
    if (typeof parsed.error === 'string' && parsed.error.trim()) {
      return parsed.error;
    }
    if (typeof parsed.message === 'string' && parsed.message.trim()) {
      return parsed.message;
    }
  } catch {
    return message;
  }
  return message;
};

const toFriendlyCategorySectionError = (message: string) => {
  const normalizedMessage = getApiErrorMessage(message);
  if (!normalizedMessage) {
    return '\u041d\u0435 \u0443\u0434\u0430\u043b\u043e\u0441\u044c \u0441\u043e\u0445\u0440\u0430\u043d\u0438\u0442\u044c \u0440\u0430\u0437\u0434\u0435\u043b.';
  }
  if (normalizedMessage.includes('File is too large')) {
    return '\u0424\u0430\u0439\u043b \u0441\u043b\u0438\u0448\u043a\u043e\u043c \u0431\u043e\u043b\u044c\u0448\u043e\u0439. \u041c\u0430\u043a\u0441\u0438\u043c\u0443\u043c 5 \u041c\u0411.';
  }
  if (normalizedMessage.includes('Only images allowed')) {
    return '\u041c\u043e\u0436\u043d\u043e \u0437\u0430\u0433\u0440\u0443\u0436\u0430\u0442\u044c \u0442\u043e\u043b\u044c\u043a\u043e \u0438\u0437\u043e\u0431\u0440\u0430\u0436\u0435\u043d\u0438\u044f.';
  }
  if (normalizedMessage.includes('Category URL already exists')) {
    return '\u0422\u0430\u043a\u043e\u0439 URL \u0443\u0436\u0435 \u0437\u0430\u043d\u044f\u0442. \u0423\u043a\u0430\u0436\u0438\u0442\u0435 \u0434\u0440\u0443\u0433\u043e\u0439.';
  }
  if (normalizedMessage.includes('Category slug must contain only latin letters')) {
    return 'URL \u0434\u043e\u043b\u0436\u0435\u043d \u0441\u043e\u0434\u0435\u0440\u0436\u0430\u0442\u044c \u0442\u043e\u043b\u044c\u043a\u043e \u043b\u0430\u0442\u0438\u043d\u0438\u0446\u0443, \u0446\u0438\u0444\u0440\u044b \u0438 \u0434\u0435\u0444\u0438\u0441.';
  }
  return normalizedMessage;
};

const createCategorySectionEditorState = (
  category: Category
): CategorySectionEditorState => ({
  name: category.name,
  slug: category.slug,
  imageFile: null,
  imagePreview: null,
  removeImage: false,
  isSubmitting: false,
  status: null,
  error: null
});



const formatPriceInput = (priceCents: number) => {
  const value = (priceCents / 100).toFixed(2);
  return value.endsWith('.00') ? value.slice(0, -3) : value;
};

const formatPriceLabel = (priceCents: number) =>
  new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency: 'RUB',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0
  }).format(priceCents / 100);

const DeleteCrossIcon = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="17"
    height="17"
    viewBox="0 0 17 17"
    fill="none"
    aria-hidden="true"
  >
    <path
      d="M16.5 0.5L0.5 16.5M16.5 16.5L0.5 0.5"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const EditPencilIcon = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    width="17"
    height="17"
    fill="currentColor"
    aria-hidden="true"
  >
    <path d="m4.5,1h5.515c.334,0,.663.03.985.088v5.412c0,1.378,1.122,2.5,2.5,2.5h5.411c.033.178.057.359.071.541.022.275.274.479.539.458.275-.022.48-.264.458-.539-.125-1.536-.793-2.981-1.883-4.07l-3.485-3.485c-1.228-1.228-2.86-1.904-4.596-1.904h-5.515C2.019,0,0,2.019,0,4.5v15c0,2.481,2.019,4.5,4.5,4.5h4c.276,0,.5-.224.5-.5s-.224-.5-.5-.5h-4c-1.93,0-3.5-1.57-3.5-3.5V4.5c0-1.93,1.57-3.5,3.5-3.5Zm12.889,5.096c.545.545.965,1.195,1.24,1.904h-5.129c-.827,0-1.5-.673-1.5-1.5V1.368c.706.273,1.353.692,1.904,1.243l3.485,3.485Zm5.878,5.636c-.943-.944-2.592-.944-3.535,0l-7.707,7.707c-.661.661-1.025,1.54-1.025,2.475v1.586c0,.276.224.5.5.5h1.586c.935,0,1.814-.364,2.475-1.025l7.707-7.707c.472-.472.732-1.1.732-1.768s-.26-1.296-.732-1.768Zm-.707,2.828l-7.707,7.707c-.472.472-1.1.732-1.768.732h-1.086v-1.086c0-.668.26-1.295.732-1.768l7.707-7.707c.566-.566,1.555-.566,2.121,0,.283.283.439.66.439,1.061s-.156.777-.439,1.061Z" />
  </svg>
);

const StockSortIcon = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    width="16"
    height="16"
    fill="currentColor"
    aria-hidden="true"
  >
    <path d="M11.854,18.561c.195,.195,.195,.512,0,.707l-4.293,4.293c-.283,.283-.66,.439-1.061,.439s-.777-.156-1.061-.439L1.146,19.268c-.195-.195-.195-.512,0-.707s.512-.195,.707,0l4.146,4.146V.5c0-.276,.224-.5,.5-.5s.5,.224,.5,.5V22.707l4.146-4.146c.195-.195,.512-.195,.707,0ZM22.854,4.732L18.561,.439c-.566-.566-1.555-.566-2.121,0l-4.293,4.293c-.195,.195-.195,.512,0,.707s.512,.195,.707,0L17,1.293V23.5c0,.276,.224,.5,.5,.5s.5-.224,.5-.5V1.293l4.146,4.146c.098,.098,.226,.146,.354,.146s.256-.049,.354-.146c.195-.195,.195-.512,0-.707Z" />
  </svg>
);

const LogoutIcon = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    width="16"
    height="16"
    fill="currentColor"
    aria-hidden="true"
  >
    <path d="M8,23.5c0,.276-.224,.5-.5,.5H3.5c-1.93,0-3.5-1.57-3.5-3.5V3.5C0,1.57,1.57,0,3.5,0H7.5c.276,0,.5,.224,.5,.5s-.224,.5-.5,.5H3.5c-1.378,0-2.5,1.121-2.5,2.5V20.5c0,1.379,1.122,2.5,2.5,2.5H7.5c.276,0,.5,.224,.5,.5Zm16-11.5s0,0,0,0c0-.473-.184-.918-.52-1.253l-4.628-4.601c-.196-.193-.512-.193-.707,.002-.195,.196-.194,.513,.002,.707,0,0,4.645,4.631,4.658,4.646H5.5c-.276,0-.5,.224-.5,.5s.224,.5,.5,.5H22.803c-.011,.013-4.656,4.646-4.656,4.646-.196,.194-.197,.512-.002,.707,.098,.099,.226,.147,.354,.147,.127,0,.255-.049,.353-.146l4.628-4.604c.335-.334,.518-.777,.519-1.249,0,0,0,0,0,0,0,0,0,0,0,0Z" />
  </svg>
);

const AdminPage = () => {
  const [authStatus, setAuthStatus] = useState<'checking' | 'guest' | 'auth'>('checking');
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [authMessage, setAuthMessage] = useState<string | null>(null);
  const [authMode, setAuthMode] = useState<'code' | 'password'>('code');
  const [password, setPassword] = useState('');
  const [isSendingCode, setIsSendingCode] = useState(false);
  const [isVerifying, setIsVerifying] = useState(false);
  const [authCaptchaToken, setAuthCaptchaToken] = useState<string | null>(null);
  const [authCaptchaResetKey, setAuthCaptchaResetKey] = useState(0);
  const [fontTheme, setFontTheme] = useState<FontTheme>(() => getStoredFontTheme());
  const turnstileSiteKey = (import.meta.env.VITE_TURNSTILE_SITE_KEY ?? '').trim();
  const authPhoneReadyForCaptcha = isPhoneReadyForCaptcha(phone);
  const handleAuthCaptchaTokenChange = useCallback((token: string | null) => {
    setAuthCaptchaToken(token);
  }, []);

  const [categories, setCategories] = useState<Category[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [boxTypes, setBoxTypes] = useState<BoxType[]>([]);
  const [deliveryProviders, setDeliveryProviders] = useState<DeliveryProviderSetting[]>([]);
  const [homeBanner, setHomeBanner] = useState<HomeBanner | null>(null);
  const [categorySectionEditors, setCategorySectionEditors] = useState<
    Record<string, CategorySectionEditorState>
  >({});
  const [isLoading, setIsLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<
    'products' | 'sections' | 'boxes' | 'deliveries' | 'banners' | 'fonts'
  >('products');
  const [viewMode, setViewMode] = useState<'grid' | 'table'>('table');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [stockSort, setStockSort] = useState<'none' | 'desc' | 'asc'>('none');

  const [name, setName] = useState('');
  const [sku, setSku] = useState('');
  const [description, setDescription] = useState('');
  const [price, setPrice] = useState('');
  const [stock, setStock] = useState('');
  const [weightGrams, setWeightGrams] = useState('500');
  const [lengthCm, setLengthCm] = useState('10');
  const [widthCm, setWidthCm] = useState('10');
  const [heightCm, setHeightCm] = useState('10');
  const [category, setCategory] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [existingImages, setExistingImages] = useState<string[]>([]);
  const [newImages, setNewImages] = useState<File[]>([]);
  const [newPreviews, setNewPreviews] = useState<string[]>([]);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [showInSlider, setShowInSlider] = useState(false);
  const [isHidden, setIsHidden] = useState(false);
  const [sliderOrder, setSliderOrder] = useState('0');
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [boxName, setBoxName] = useState('');
  const [boxLengthCm, setBoxLengthCm] = useState('20');
  const [boxWidthCm, setBoxWidthCm] = useState('15');
  const [boxHeightCm, setBoxHeightCm] = useState('10');
  const [boxMaxWeightGrams, setBoxMaxWeightGrams] = useState('2000');
  const [boxEmptyWeightGrams, setBoxEmptyWeightGrams] = useState('120');
  const [boxFillRatio, setBoxFillRatio] = useState('0.82');
  const [boxSortOrder, setBoxSortOrder] = useState('0');
  const [editingBoxId, setEditingBoxId] = useState<string | null>(null);
  const [boxStatus, setBoxStatus] = useState<string | null>(null);
  const [boxError, setBoxError] = useState<string | null>(null);
  const [isBoxSubmitting, setIsBoxSubmitting] = useState(false);
  const [deliveryStatus, setDeliveryStatus] = useState<string | null>(null);
  const [deliveryError, setDeliveryError] = useState<string | null>(null);
  const [deliveryUpdatingKey, setDeliveryUpdatingKey] = useState<string | null>(null);
  const [desktopBannerFile, setDesktopBannerFile] = useState<File | null>(null);
  const [mobileBannerFile, setMobileBannerFile] = useState<File | null>(null);
  const [desktopBannerPreview, setDesktopBannerPreview] = useState<string | null>(null);
  const [mobileBannerPreview, setMobileBannerPreview] = useState<string | null>(null);
  const [bannerStatus, setBannerStatus] = useState<string | null>(null);
  const [bannerError, setBannerError] = useState<string | null>(null);
  const [isBannerSubmitting, setIsBannerSubmitting] = useState(false);
  const [pendingDeleteCategory, setPendingDeleteCategory] = useState<Category | null>(null);
  const [isCategoryDeleting, setIsCategoryDeleting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const desktopBannerInputRef = useRef<HTMLInputElement | null>(null);
  const mobileBannerInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    applyFontTheme(fontTheme);
  }, [fontTheme]);

  useEffect(() => {
    const token = getAuthToken();
    if (!token) {
      setAuthStatus('guest');
      return;
    }

    fetchMe()
      .then((user) => {
        setAuthUser(user);
        setAuthStatus('auth');
      })
      .catch(() => {
        clearAuthToken();
        setAuthStatus('guest');
      });
  }, []);

  const loadData = async () => {
    setIsLoading(true);
    try {
      const [categoryItems, productItems, boxItems, deliveryItems, banner] = await Promise.all([
        fetchCategories(),
        fetchProducts({ includeHidden: true }),
        fetchBoxTypes(),
        fetchDeliveryProviders(),
        fetchHomeBanner()
      ]);
      setCategories(categoryItems);
      setProducts(productItems);
      setBoxTypes(boxItems);
      setDeliveryProviders(deliveryItems);
      setHomeBanner(banner);
      setCategory((prev) =>
        prev && categoryItems.some((item) => item.slug === prev)
          ? prev
          : categoryItems[0]?.slug || ''
      );
      setCategorySectionEditors((prev) => {
        const next: Record<string, CategorySectionEditorState> = {};
        categoryItems.forEach((item) => {
          const existing = prev[item.slug];
          next[item.slug] = {
            ...createCategorySectionEditorState(item),
            status: existing?.status ?? null,
            error: existing?.error ?? null
          };
        });
        return next;
      });
      setIsLoading(false);
    } catch {
      setError('Не удалось загрузить данные.');
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (authStatus === 'auth' && authUser?.role === 'admin') {
      loadData();
    }
  }, [authStatus, authUser]);

  const resetForm = () => {
    setName('');
    setSku('');
    setDescription('');
    setPrice('');
    setStock('');
    setWeightGrams('500');
    setLengthCm('10');
    setWidthCm('10');
    setHeightCm('10');
    setEditingId(null);
    setExistingImages([]);
    setNewImages([]);
    setNewPreviews([]);
    setShowInSlider(false);
    setIsHidden(false);
    setSliderOrder('0');
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const resetBoxForm = () => {
    setEditingBoxId(null);
    setBoxName('');
    setBoxLengthCm('20');
    setBoxWidthCm('15');
    setBoxHeightCm('10');
    setBoxMaxWeightGrams('2000');
    setBoxEmptyWeightGrams('120');
    setBoxFillRatio('0.82');
    setBoxSortOrder('0');
  };

  const handleImagesChange = async (event: ChangeEvent<HTMLInputElement>) => {
    setStatus(null);
    setError(null);
    const files = Array.from(event.target.files ?? []);
    const limited = files.slice(0, MAX_IMAGES);
    if (files.length > MAX_IMAGES) {
      setError(`Можно выбрать максимум ${MAX_IMAGES} изображений.`);
    }

    try {
      const prepared = await Promise.all(
        limited.map(async (file) => {
          const [preview, memoryFile] = await Promise.all([
            readFileAsDataUrl(file),
            copyFileToMemory(file)
          ]);
          return { preview, file: memoryFile };
        })
      );
      setNewImages(prepared.map((item) => item.file));
      setNewPreviews(prepared.map((item) => item.preview));
    } catch {
      setError('Не удалось обработать изображения.');
    }
  };

  const handleRemoveNewImage = (index: number) => {
    setNewImages((prev) => prev.filter((_, itemIndex) => itemIndex !== index));
    setNewPreviews((prev) => prev.filter((_, itemIndex) => itemIndex !== index));
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleRemoveExistingImage = (index: number) => {
    setExistingImages((prev) => prev.filter((_, itemIndex) => itemIndex !== index));
  };

  const setDragImageFromEvent = (event: DragEvent<HTMLDivElement>) => {
    const img = event.currentTarget.querySelector('img');
    if (img) {
      const rect = img.getBoundingClientRect();
      if (rect.width && rect.height) {
        event.dataTransfer.setDragImage(img, rect.width / 2, rect.height / 2);
        return;
      }
    }

    const fallbackRect = event.currentTarget.getBoundingClientRect();
    if (fallbackRect.width && fallbackRect.height) {
      event.dataTransfer.setDragImage(
        event.currentTarget,
        fallbackRect.width / 2,
        fallbackRect.height / 2
      );
    }
  };

  const handleDragStart = (event: DragEvent<HTMLDivElement>, index: number) => {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', String(index));
    setDragImageFromEvent(event);
    setDragIndex(index);
  };

  const handleDragOver = (event: DragEvent<HTMLDivElement>, index: number) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    if (dragOverIndex !== index) {
      setDragOverIndex(index);
    }
  };

  const handleDragLeave = (event: DragEvent<HTMLDivElement>, index: number) => {
    const related = event.relatedTarget as Node | null;
    if (related && event.currentTarget.contains(related)) {
      return;
    }
    if (dragOverIndex === index) {
      setDragOverIndex(null);
    }
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>, index: number) => {
    event.preventDefault();
    if (dragIndex === null) {
      return;
    }
    if (dragIndex !== index) {
      setNewImages((prev) => moveItem(prev, dragIndex, index));
      setNewPreviews((prev) => moveItem(prev, dragIndex, index));
    }
    setDragIndex(null);
    setDragOverIndex(null);
  };

  const handleExistingDrop = (event: DragEvent<HTMLDivElement>, index: number) => {
    event.preventDefault();
    if (dragIndex === null) {
      return;
    }
    if (dragIndex !== index) {
      setExistingImages((prev) => moveItem(prev, dragIndex, index));
    }
    setDragIndex(null);
    setDragOverIndex(null);
  };

  const handleDragEnd = () => {
    setDragIndex(null);
    setDragOverIndex(null);
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setStatus(null);
    setError(null);

    if (
      !name.trim() ||
      !sku.trim() ||
      !price.trim() ||
      !weightGrams.trim() ||
      !lengthCm.trim() ||
      !widthCm.trim() ||
      !heightCm.trim() ||
      !category
    ) {
      setError('Заполните название, SKU, цену, вес, габариты и категорию.');
      return;
    }

    setIsSubmitting(true);

    const formData = new FormData();
    formData.append('name', name.trim());
    formData.append('sku', sku.trim());
    formData.append('description', description.trim());
    formData.append('price', price.trim());
    const stockValue = stock.trim() === '' ? '0' : stock.trim();
    formData.append('stock', stockValue);
    formData.append('weightGrams', weightGrams.trim());
    formData.append('lengthCm', lengthCm.trim());
    formData.append('widthCm', widthCm.trim());
    formData.append('heightCm', heightCm.trim());
    formData.append('category', category);
    formData.append('showInSlider', showInSlider ? 'true' : 'false');
    formData.append('isHidden', isHidden ? 'true' : 'false');
    formData.append('sliderOrder', sliderOrder.trim() || '0');

    if (newImages.length > 0) {
      newImages.forEach((file) => formData.append('images', file));
      formData.append('replaceImages', 'true');
    }
    if (editingId && newImages.length === 0 && existingImages.length > 0) {
      const order = existingImages.map(getImageName);
      formData.append('imagesOrder', JSON.stringify(order));
    }

    try {
      if (editingId) {
        const updated = await updateProduct(editingId, formData);
        setProducts((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
        setStatus('Товар обновлен.');
      } else {
        const created = await createProduct(formData);
        setProducts((prev) => [created, ...prev]);
        setStatus('Товар добавлен.');
      }
      resetForm();
    } catch (submitError) {
      if (submitError instanceof Error) {
        setError(submitError.message);
      } else {
        setError('Не удалось сохранить товар.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleEdit = (product: Product) => {
    setEditingId(product.id);
    setName(product.name);
    setSku(product.sku);
    setDescription(product.description);
    setPrice(formatPriceInput(product.priceCents));
    setStock(product.stock === 0 ? '' : String(product.stock ?? 0));
    setWeightGrams(String(product.weightGrams));
    setLengthCm(String(product.lengthCm));
    setWidthCm(String(product.widthCm));
    setHeightCm(String(product.heightCm));
    setCategory(product.category);
    setExistingImages(product.images);
    setShowInSlider(product.showInSlider);
    setIsHidden(product.isHidden);
    setSliderOrder(String(product.sliderOrder ?? 0));
    setNewImages([]);
    setNewPreviews([]);
    setStatus(null);
    setError(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleDelete = async (product: Product) => {
    const confirmed = window.confirm(`Удалить товар "${product.name}"?`);
    if (!confirmed) {
      return;
    }

    setError(null);
    setStatus(null);
    try {
      await deleteProduct(product.id);
      setProducts((prev) => prev.filter((item) => item.id !== product.id));
      if (editingId === product.id) {
        resetForm();
      }
      setStatus('Товар удален.');
    } catch {
      setError('Не удалось удалить товар.');
    }
  };

  const handleBoxSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBoxStatus(null);
    setBoxError(null);

    const nameValue = boxName.trim();
    const lengthValue = Number.parseInt(boxLengthCm, 10);
    const widthValue = Number.parseInt(boxWidthCm, 10);
    const heightValue = Number.parseInt(boxHeightCm, 10);
    const maxWeightValue = Number.parseInt(boxMaxWeightGrams, 10);
    const emptyWeightValue = Number.parseInt(boxEmptyWeightGrams, 10);
    const fillRatioValue = Number.parseFloat(boxFillRatio.replace(',', '.'));
    const sortOrderValue = Number.parseInt(boxSortOrder || '0', 10);

    if (!nameValue) {
      setBoxError('Укажите название коробки.');
      return;
    }

    if (
      !Number.isFinite(lengthValue) ||
      !Number.isFinite(widthValue) ||
      !Number.isFinite(heightValue) ||
      lengthValue < 1 ||
      widthValue < 1 ||
      heightValue < 1
    ) {
      setBoxError('Габариты коробки должны быть целыми числами больше нуля.');
      return;
    }

    if (
      !Number.isFinite(maxWeightValue) ||
      !Number.isFinite(emptyWeightValue) ||
      maxWeightValue < 1 ||
      emptyWeightValue < 0
    ) {
      setBoxError('Проверьте поля веса коробки.');
      return;
    }

    if (!Number.isFinite(fillRatioValue) || fillRatioValue <= 0 || fillRatioValue > 1) {
      setBoxError('Заполнение должно быть в диапазоне от 0.01 до 1.');
      return;
    }

    if (!Number.isFinite(sortOrderValue) || sortOrderValue < 0) {
      setBoxError('Порядок должен быть нулём или положительным числом.');
      return;
    }

    setIsBoxSubmitting(true);
    try {
      const payload = {
        name: nameValue,
        lengthCm: lengthValue,
        widthCm: widthValue,
        heightCm: heightValue,
        maxWeightGrams: maxWeightValue,
        emptyWeightGrams: emptyWeightValue,
        fillRatio: fillRatioValue,
        sortOrder: sortOrderValue
      };

      if (editingBoxId) {
        await updateBoxType(editingBoxId, payload);
        setBoxStatus('Тип коробки обновлён.');
      } else {
        await createBoxType(payload);
        setBoxStatus('Тип коробки добавлен.');
      }

      const items = await fetchBoxTypes();
      setBoxTypes(items);
      resetBoxForm();
    } catch (submitError) {
      if (submitError instanceof Error) {
        setBoxError(submitError.message);
      } else {
        setBoxError('Не удалось сохранить тип коробки.');
      }
    } finally {
      setIsBoxSubmitting(false);
    }
  };

  const handleEditBox = (boxType: BoxType) => {
    setEditingBoxId(boxType.id);
    setBoxName(boxType.name);
    setBoxLengthCm(String(boxType.lengthCm));
    setBoxWidthCm(String(boxType.widthCm));
    setBoxHeightCm(String(boxType.heightCm));
    setBoxMaxWeightGrams(String(boxType.maxWeightGrams));
    setBoxEmptyWeightGrams(String(boxType.emptyWeightGrams));
    setBoxFillRatio(String(boxType.fillRatio));
    setBoxSortOrder(String(boxType.sortOrder));
    setBoxStatus(null);
    setBoxError(null);
  };

  const handleDeleteBox = async (boxType: BoxType) => {
    const confirmed = window.confirm(`Удалить тип коробки "${boxType.name}"?`);
    if (!confirmed) {
      return;
    }

    setBoxStatus(null);
    setBoxError(null);
    try {
      await deleteBoxType(boxType.id);
      setBoxTypes((prev) => prev.filter((item) => item.id !== boxType.id));
      if (editingBoxId === boxType.id) {
        resetBoxForm();
      }
      setBoxStatus('Тип коробки удалён.');
    } catch (deleteError) {
      if (deleteError instanceof Error) {
        setBoxError(deleteError.message);
      } else {
        setBoxError('Не удалось удалить тип коробки.');
      }
    }
  };

  const handleDeliveryProviderToggle = async (
    provider: DeliveryProviderSetting,
    isEnabled: boolean
  ) => {
    if (provider.isEnabled === isEnabled || deliveryUpdatingKey) {
      return;
    }

    setDeliveryStatus(null);
    setDeliveryError(null);
    setDeliveryUpdatingKey(provider.key);

    try {
      const updated = await updateDeliveryProvider(provider.key, isEnabled);
      setDeliveryProviders((prev) =>
        prev.map((item) => (item.key === updated.key ? updated : item))
      );
      setDeliveryStatus('Настройки доставки сохранены.');
    } catch (updateError) {
      if (updateError instanceof Error) {
        setDeliveryError(updateError.message);
      } else {
        setDeliveryError('Не удалось обновить настройки доставки.');
      }
    } finally {
      setDeliveryUpdatingKey(null);
    }
  };

  const resetBannerForm = () => {
    setDesktopBannerFile(null);
    setMobileBannerFile(null);
    setDesktopBannerPreview(null);
    setMobileBannerPreview(null);
    if (desktopBannerInputRef.current) {
      desktopBannerInputRef.current.value = '';
    }
    if (mobileBannerInputRef.current) {
      mobileBannerInputRef.current.value = '';
    }
  };

  const handleDesktopBannerChange = async (event: ChangeEvent<HTMLInputElement>) => {
    setBannerStatus(null);
    setBannerError(null);
    const file = event.target.files?.[0] ?? null;
    if (!file) {
      setDesktopBannerFile(null);
      setDesktopBannerPreview(null);
      return;
    }
    try {
      const preview = await readFileAsDataUrl(file);
      setDesktopBannerFile(file);
      setDesktopBannerPreview(preview);
    } catch {
      setBannerError('Не удалось прочитать изображение desktop-баннера.');
    }
  };

  const handleMobileBannerChange = async (event: ChangeEvent<HTMLInputElement>) => {
    setBannerStatus(null);
    setBannerError(null);
    const file = event.target.files?.[0] ?? null;
    if (!file) {
      setMobileBannerFile(null);
      setMobileBannerPreview(null);
      return;
    }
    try {
      const preview = await readFileAsDataUrl(file);
      setMobileBannerFile(file);
      setMobileBannerPreview(preview);
    } catch {
      setBannerError('Не удалось прочитать изображение mobile-баннера.');
    }
  };

  const handleBannerSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBannerStatus(null);
    setBannerError(null);

    if (!desktopBannerFile && !mobileBannerFile) {
      setBannerError('Выберите минимум одно изображение для обновления.');
      return;
    }

    const payload = new FormData();
    if (desktopBannerFile) {
      payload.append('desktopImage', desktopBannerFile);
    }
    if (mobileBannerFile) {
      payload.append('mobileImage', mobileBannerFile);
    }

    setIsBannerSubmitting(true);
    try {
      const updatedBanner = await updateHomeBanner(payload);
      setHomeBanner(updatedBanner);
      resetBannerForm();
      setBannerStatus('Баннеры обновлены.');
    } catch (submitError) {
      if (submitError instanceof Error) {
        setBannerError(submitError.message);
      } else {
        setBannerError('Не удалось обновить баннеры.');
      }
    } finally {
      setIsBannerSubmitting(false);
    }
  };

  const handleCategorySectionNameChange = (slug: string, value: string) => {
    setCategorySectionEditors((prev) => ({
      ...prev,
      [slug]: {
        ...(prev[slug] ??
          createCategorySectionEditorState({
            slug,
            name: value,
            image: null,
            createdAt: '',
            updatedAt: ''
          })),
        name: value,
        slug: toCategorySlug(value),
        status: null,
        error: null
      }
    }));
  };

  const handleCategorySectionSlugChange = (slug: string, value: string) => {
    const normalized = toCategorySlug(value);
    setCategorySectionEditors((prev) => ({
      ...prev,
      [slug]: {
        ...(prev[slug] ??
          createCategorySectionEditorState({
            slug,
            name: '',
            image: null,
            createdAt: '',
            updatedAt: ''
          })),
        slug: normalized,
        status: null,
        error: null
      }
    }));
  };

  const handleCategorySectionImageChange = async (
    slug: string,
    event: ChangeEvent<HTMLInputElement>
  ) => {
    const file = event.target.files?.[0] ?? null;
    if (!file) {
      return;
    }

    try {
      const preview = await readFileAsDataUrl(file);
      setCategorySectionEditors((prev) => ({
        ...prev,
        [slug]: {
          ...(prev[slug] ??
            createCategorySectionEditorState({
              slug,
              name: '',
              image: null,
              createdAt: '',
              updatedAt: ''
            })),
          imageFile: file,
          imagePreview: preview,
          removeImage: false,
          status: null,
          error: null
        }
      }));
    } catch {
      setCategorySectionEditors((prev) => ({
        ...prev,
        [slug]: {
          ...(prev[slug] ??
            createCategorySectionEditorState({
              slug,
              name: '',
              image: null,
              createdAt: '',
              updatedAt: ''
            })),
          status: null,
          error: '\u041d\u0435 \u0443\u0434\u0430\u043b\u043e\u0441\u044c \u043f\u0440\u043e\u0447\u0438\u0442\u0430\u0442\u044c \u0438\u0437\u043e\u0431\u0440\u0430\u0436\u0435\u043d\u0438\u0435 \u043a\u0430\u0442\u0435\u0433\u043e\u0440\u0438\u0438.'
        }
      }));
    }
  };

  const handleCategorySectionImageRemove = (slug: string) => {
    setCategorySectionEditors((prev) => ({
      ...prev,
      [slug]: {
        ...(prev[slug] ??
          createCategorySectionEditorState({
            slug,
            name: '',
            image: null,
            createdAt: '',
            updatedAt: ''
          })),
        imageFile: null,
        imagePreview: null,
        removeImage: true,
        status: null,
        error: null
      }
    }));
  };

  const resetCategorySectionDraft = (categoryItem: Category) => {
    setCategorySectionEditors((prev) => ({
      ...prev,
      [categoryItem.slug]: createCategorySectionEditorState(categoryItem)
    }));
  };

  const handleCategorySectionSubmit = async (
    event: FormEvent<HTMLFormElement>,
    categoryItem: Category
  ) => {
    event.preventDefault();
    const editor =
      categorySectionEditors[categoryItem.slug] ??
      createCategorySectionEditorState(categoryItem);
    const nextName = editor.name.trim();
    const nextSlug = editor.slug.trim();
    const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

    if (!nextName) {
      setCategorySectionEditors((prev) => ({
        ...prev,
        [categoryItem.slug]: {
          ...editor,
          status: null,
          error: '\u0423\u043a\u0430\u0436\u0438\u0442\u0435 \u043d\u0430\u0437\u0432\u0430\u043d\u0438\u0435 \u043a\u0430\u0442\u0435\u0433\u043e\u0440\u0438\u0438.'
        }
      }));
      return;
    }

    if (!nextSlug || !slugPattern.test(nextSlug)) {
      setCategorySectionEditors((prev) => ({
        ...prev,
        [categoryItem.slug]: {
          ...editor,
          status: null,
          error: 'URL \u0434\u043e\u043b\u0436\u0435\u043d \u0441\u043e\u0434\u0435\u0440\u0436\u0430\u0442\u044c \u0442\u043e\u043b\u044c\u043a\u043e \u043b\u0430\u0442\u0438\u043d\u0438\u0446\u0443, \u0446\u0438\u0444\u0440\u044b \u0438 \u0434\u0435\u0444\u0438\u0441.'
        }
      }));
      return;
    }

    setCategorySectionEditors((prev) => ({
      ...prev,
      [categoryItem.slug]: {
        ...editor,
        isSubmitting: true,
        status: null,
        error: null
      }
    }));

    const payload = new FormData();
    payload.append('name', nextName);
    payload.append('slug', nextSlug);
    if (editor.imageFile) {
      payload.append('image', editor.imageFile);
    } else if (editor.removeImage) {
      payload.append('removeImage', 'true');
    }

    try {
      const updated = await updateCategorySection(categoryItem.slug, payload);
      setCategories((prev) =>
        prev.map((item) => (item.slug === categoryItem.slug ? updated : item))
      );
      if (updated.slug !== categoryItem.slug) {
        setProducts((prev) =>
          prev.map((item) =>
            item.category === categoryItem.slug ? { ...item, category: updated.slug } : item
          )
        );
      }
      setCategorySectionEditors((prev) => {
        const next = { ...prev };
        delete next[categoryItem.slug];
        next[updated.slug] = {
          ...createCategorySectionEditorState(updated),
          status: '\u0420\u0430\u0437\u0434\u0435\u043b \u0441\u043e\u0445\u0440\u0430\u043d\u0435\u043d.'
        };
        return next;
      });
    } catch (submitError) {
      setCategorySectionEditors((prev) => ({
        ...prev,
        [categoryItem.slug]: {
          ...(prev[categoryItem.slug] ?? editor),
          isSubmitting: false,
          status: null,
          error:
            submitError instanceof Error
              ? toFriendlyCategorySectionError(submitError.message)
              : '\u041d\u0435 \u0443\u0434\u0430\u043b\u043e\u0441\u044c \u0441\u043e\u0445\u0440\u0430\u043d\u0438\u0442\u044c \u0440\u0430\u0437\u0434\u0435\u043b.'
        }
      }));
    }
  };

  const openDeleteCategoryModal = (categoryItem: Category) => {
    setPendingDeleteCategory(categoryItem);
  };

  const closeDeleteCategoryModal = () => {
    if (isCategoryDeleting) {
      return;
    }
    setPendingDeleteCategory(null);
  };

  const handleConfirmDeleteCategory = async () => {
    if (!pendingDeleteCategory) {
      return;
    }

    const categoryToDelete = pendingDeleteCategory;
    setIsCategoryDeleting(true);
    try {
      await deleteCategorySection(categoryToDelete.slug);
      setCategories((prev) => {
        const next = prev.filter((item) => item.slug !== categoryToDelete.slug);
        setCategory((current) => (current === categoryToDelete.slug ? (next[0]?.slug ?? '') : current));
        return next;
      });
      setCategorySectionEditors((prev) => {
        const next = { ...prev };
        delete next[categoryToDelete.slug];
        return next;
      });
      setPendingDeleteCategory(null);
    } catch (deleteError) {
      const errorMessage =
        deleteError instanceof Error
          ? toFriendlyCategorySectionError(deleteError.message)
          : 'Не удалось удалить категорию.';
      setCategorySectionEditors((prev) => ({
        ...prev,
        [categoryToDelete.slug]: {
          ...(prev[categoryToDelete.slug] ?? createCategorySectionEditorState(categoryToDelete)),
          isSubmitting: false,
          status: null,
          error: errorMessage
        }
      }));
      setPendingDeleteCategory(null);
    } finally {
      setIsCategoryDeleting(false);
    }
  };

  const handleRequestCode = async () => {
    setAuthMessage(null);
    setError(null);
    if (!phone.trim()) {
      setAuthMessage('Введите номер телефона.');
      return;
    }

    if (!authPhoneReadyForCaptcha) {
      setAuthMessage('Введите полный номер телефона.');
      return;
    }

    if (turnstileSiteKey && !authCaptchaToken) {
      setAuthMessage('Подтвердите, что вы не робот.');
      return;
    }

    setIsSendingCode(true);
    try {
      const result = await requestAuthCode(phone.trim(), undefined, authCaptchaToken ?? undefined);
      if (result.requiresPassword) {
        setAuthMode('password');
        setAuthMessage('Введите пароль администратора.');
        return;
      }
      setAuthMode('code');
      setAuthMessage('Код отправлен.');
    } catch {
      setAuthMessage('Не удалось отправить код.');
    } finally {
      setIsSendingCode(false);
      if (turnstileSiteKey) {
        setAuthCaptchaToken(null);
        setAuthCaptchaResetKey((prev) => prev + 1);
      }
    }
  };

  const handleFontThemeChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const nextTheme = event.target.value === 'franklin' ? 'franklin' : 'default';
    setFontTheme(nextTheme);
    setStoredFontTheme(nextTheme);
  };

  const handleVerify = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setAuthMessage(null);
    if (!phone.trim()) {
      setAuthMessage('Введите номер телефона.');
      return;
    }
    if (authMode === 'password') {
      if (!password.trim()) {
        setAuthMessage('Введите пароль.');
        return;
      }
    } else if (!code.trim()) {
      setAuthMessage('Введите код.');
      return;
    }

    setIsVerifying(true);
    try {
      const result =
        authMode === 'password'
          ? await verifyAuthCode(phone.trim(), '', password.trim())
          : await verifyAuthCode(phone.trim(), code.trim());
      setAuthToken(result.token);
      setAuthUser(result.user);
      setAuthStatus('auth');
      setCode('');
      setPassword('');
      setAuthMessage(null);
    } catch {
      setAuthMessage(authMode === 'password' ? 'Неверный пароль.' : 'Неверный код.');
    } finally {
      setIsVerifying(false);
    }
  };

  const handleLogout = () => {
    clearAuthToken();
    setAuthUser(null);
    setAuthStatus('guest');
  };

  const handleStockSortToggle = () => {
    setStockSort((prev) => {
      if (prev === 'none') {
        return 'desc';
      }
      if (prev === 'desc') {
        return 'asc';
      }
      return 'none';
    });
  };

  const categoryNameBySlug = categories.reduce<Record<string, string>>((acc, item) => {
    acc[item.slug] = item.name;
    return acc;
  }, {});

  const filteredProducts =
    categoryFilter === 'all'
      ? products
      : products.filter((product) => product.category === categoryFilter);

  const displayedProducts =
    stockSort === 'none'
      ? filteredProducts
      : [...filteredProducts].sort((a, b) => {
          const aStock = a.stock ?? 0;
          const bStock = b.stock ?? 0;
          return stockSort === 'desc' ? bStock - aStock : aStock - bStock;
        });

  const stockSortLabel = stockSort === 'desc' ? '↓' : stockSort === 'asc' ? '↑' : '';
  let activeTabTitle = 'Товары';
  let activeTabDescription = 'Добавление, редактирование и удаление карточек.';

  if (activeTab === 'boxes') {
    activeTabTitle = 'Коробки';
    activeTabDescription = 'Настройка типов коробок для расчёта доставки.';
  } else if (activeTab === 'sections') {
    activeTabTitle = 'Разделы каталога';
    activeTabDescription = 'Редактирование названий и фотографий 4 категорий.';
  } else if (activeTab === 'deliveries') {
    activeTabTitle = 'Доставки';
    activeTabDescription = 'Включение и отключение доступных способов доставки на сайте.';
  } else if (activeTab === 'banners') {
    activeTabTitle = 'Баннеры';
    activeTabDescription = 'Загрузка баннеров главной страницы для desktop и mobile.';
  } else if (activeTab === 'fonts') {
    activeTabTitle = 'Шрифты';
    activeTabDescription = 'Настройка шрифтового оформления интерфейса.';
  }

  if (authStatus === 'checking') {
    return (
      <div className="page">
        <p className="muted">Проверяем доступ...</p>
      </div>
    );
  }

  if (authStatus !== 'auth' || !authUser) {
    return (
      <div className="page">
        <header className="page-header">
          <div>
            <p className="eyebrow">Админ-панель</p>
            <h1>Вход по телефону</h1>
            <p className="muted">
              Для обычного номера код покажем в alert как тестовое SMS. Роль администратора выдаётся для номера
              +79964292550.
            </p>
          </div>
        </header>
        <div className="card">
          <form className="stacked-form" onSubmit={handleVerify}>
            <label className="field">
              <span>Телефон</span>
              <input
                type="tel"
                placeholder="+7"
                value={phone}
                onChange={(event) => {
                  setPhone(event.target.value);
                  setAuthMode('code');
                  setCode('');
                  setPassword('');
                  if (authCaptchaToken) {
                    setAuthCaptchaToken(null);
                    setAuthCaptchaResetKey((prev) => prev + 1);
                  }
                }}
                required
              />
            </label>
            {authMode === 'code' &&
              turnstileSiteKey &&
              authPhoneReadyForCaptcha &&
              !authCaptchaToken && (
              <TurnstileWidget
                siteKey={turnstileSiteKey}
                action="request_phone_code"
                resetKey={authCaptchaResetKey}
                onTokenChange={handleAuthCaptchaTokenChange}
              />
            )}
            {authMode === 'code' && (
            <div className="button-row">
              <button
                type="button"
                className="ghost-button"
                onClick={handleRequestCode}
                disabled={isSendingCode}
              >
                {isSendingCode ? 'Отправляем...' : 'Получить код'}
              </button>
            </div>
            )}
            <label className="field">
              <span>{authMode === 'password' ? 'Пароль администратора' : 'Код из консоли'}</span>
              <input
                type={authMode === 'password' ? 'password' : 'text'}
                inputMode={authMode === 'password' ? undefined : 'numeric'}
                value={authMode === 'password' ? password : code}
                onChange={(event) =>
                  authMode === 'password'
                    ? setPassword(event.target.value)
                    : setCode(event.target.value)
                }
                required
              />
            </label>
            <button className="primary-button" type="submit" disabled={isVerifying}>
              {isVerifying ? 'Проверяем...' : 'Войти'}
            </button>
            {authMessage && <p className="status-text">{authMessage}</p>}
          </form>
        </div>
      </div>
    );
  }

  if (authUser.role !== 'admin') {
    return (
      <div className="page">
        <header className="page-header">
          <div>
            <p className="eyebrow">Админ-панель</p>
            <h1>Недостаточно прав</h1>
            <p className="muted">Для доступа к админке нужен администраторский номер.</p>
          </div>
        </header>
        <div className="card">
          <a
            href="#logout"
            className="admin-logout-link"
            onClick={(event) => {
              event.preventDefault();
              handleLogout();
            }}
          >
            <span className="admin-logout-icon">
              <LogoutIcon />
            </span>
            <span>Выйти</span>
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">Админ-панель</p>
          <nav className="admin-tabs-nav" aria-label="Разделы админки">
            <a
              href="#products"
              className={`admin-tab-link${activeTab === 'products' ? ' is-active' : ''}`}
              onClick={(event) => {
                event.preventDefault();
                setActiveTab('products');
              }}
            >
              Товары
            </a>
            <a
              href="#sections"
              className={`admin-tab-link${activeTab === 'sections' ? ' is-active' : ''}`}
              onClick={(event) => {
                event.preventDefault();
                setActiveTab('sections');
              }}
            >
              Разделы каталога
            </a>
            <a
              href="#boxes"
              className={`admin-tab-link${activeTab === 'boxes' ? ' is-active' : ''}`}
              onClick={(event) => {
                event.preventDefault();
                setActiveTab('boxes');
              }}
            >
              Коробки
            </a>
            <a
              href="#deliveries"
              className={`admin-tab-link${activeTab === 'deliveries' ? ' is-active' : ''}`}
              onClick={(event) => {
                event.preventDefault();
                setActiveTab('deliveries');
              }}
            >
              Доставки
            </a>
            <a
              href="#banners"
              className={`admin-tab-link${activeTab === 'banners' ? ' is-active' : ''}`}
              onClick={(event) => {
                event.preventDefault();
                setActiveTab('banners');
              }}
            >
              Баннеры
            </a>
            <a
              href="#fonts"
              className={`admin-tab-link${activeTab === 'fonts' ? ' is-active' : ''}`}
              onClick={(event) => {
                event.preventDefault();
                setActiveTab('fonts');
              }}
            >
              Шрифты
            </a>
          </nav>
          <h1>{activeTabTitle}</h1>
          <p className="muted">{activeTabDescription}</p>
        </div>
        <a
          href="#logout"
          className="admin-logout-link"
          onClick={(event) => {
            event.preventDefault();
            handleLogout();
          }}
        >
          <span className="admin-logout-icon">
            <LogoutIcon />
          </span>
          <span>Выйти</span>
        </a>
      </header>
      {activeTab === 'products' && (
        <>
      <div className="card">
        <form className="admin-form" onSubmit={handleSubmit}>
          <div className="form-grid">
            <label className="field">
              <span>Название товара</span>
              <input
                type="text"
                placeholder="Например: Фильтр насосный Pro-1"
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
              />
            </label>
            <label className="field">
              <span>SKU</span>
              <input
                type="text"
                placeholder="PRO-001"
                value={sku}
                onChange={(event) => setSku(event.target.value)}
                required
              />
            </label>
            <label className="field">
              <span>Цена (руб.)</span>
              <input
                type="text"
                inputMode="decimal"
                placeholder="12900"
                value={price}
                onChange={(event) => setPrice(event.target.value)}
                required
              />
            </label>
            <label className="field">
              <span>Остаток (шт.)</span>
              <input
                type="number"
                min="0"
                step="1"
                placeholder="0"
                value={stock}
                onChange={(event) => setStock(event.target.value)}
                onFocus={() => {
                  if (stock === '0') {
                    setStock('');
                  }
                }}
              />
            </label>
            <label className="field">
              <span>Вес (г)</span>
              <input
                type="number"
                min="1"
                step="1"
                value={weightGrams}
                onChange={(event) => setWeightGrams(event.target.value)}
                required
              />
            </label>
            <label className="field">
              <span>Длина (см)</span>
              <input
                type="number"
                min="1"
                step="1"
                value={lengthCm}
                onChange={(event) => setLengthCm(event.target.value)}
                required
              />
            </label>
            <label className="field">
              <span>Ширина (см)</span>
              <input
                type="number"
                min="1"
                step="1"
                value={widthCm}
                onChange={(event) => setWidthCm(event.target.value)}
                required
              />
            </label>
            <label className="field">
              <span>Высота (см)</span>
              <input
                type="number"
                min="1"
                step="1"
                value={heightCm}
                onChange={(event) => setHeightCm(event.target.value)}
                required
              />
            </label>

            <label className="field">
              <span>Категория</span>
              <select
                value={category}
                onChange={(event) => setCategory(event.target.value)}
                required
                disabled={isLoading}
              >
                <option value="" disabled>
                  Выберите категорию
                </option>
                {categories.map((item) => (
                  <option key={item.slug} value={item.slug}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="field">
            <span>Описание</span>
            <textarea
              rows={4}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Краткое описание товара"
            />
          </label>
          <label className="checkbox-field">
            <input
              type="checkbox"
              checked={showInSlider}
              onChange={(event) => setShowInSlider(event.target.checked)}
            />
            <span>Отображать в слайдере на главной</span>
          </label>
          <label className="checkbox-field">
            <input
              type="checkbox"
              checked={isHidden}
              onChange={(event) => setIsHidden(event.target.checked)}
            />
            <span>Отключить отображение на сайте</span>
          </label>
          <label className="field">
            <span>Порядок в слайдере (меньше - выше)</span>
            <input
              type="number"
              min="0"
              step="1"
              value={sliderOrder}
              onChange={(event) => setSliderOrder(event.target.value)}
              disabled={!showInSlider}
            />
          </label>
          <label className="field">
            <span>Изображения (до {MAX_IMAGES})</span>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              onChange={handleImagesChange}
            />
            <span className="form-help">
              Изображения сохраняются в папку uploads на сервере.
            </span>
          </label>
          {existingImages.length > 0 && newPreviews.length === 0 && (
            <div>
              <p className="muted">Текущие изображения</p>
              <div className="image-preview">
                {existingImages.map((src, index) => (
                  <div
                    className={`image-preview-item${dragIndex === index ? ' is-dragging' : ''}${dragOverIndex === index ? ' is-drag-over' : ''}`}
                    key={src}
                    draggable
                    onDragStart={(event) => handleDragStart(event, index)}
                    onDragOver={(event) => handleDragOver(event, index)}
                    onDrop={(event) => handleExistingDrop(event, index)}
                    onDragLeave={(event) => handleDragLeave(event, index)}
                    onDragEnd={handleDragEnd}
                  >
                    <img src={src} alt="Изображение товара" />
                    <button
                      type="button"
                      className="image-preview-remove"
                      onClick={(event) => {
                        event.stopPropagation();
                        handleRemoveExistingImage(index);
                      }}
                    >
                      Удалить
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
          {newPreviews.length > 0 && (
            <div>
              <p className="muted">
                Новые изображения (заменят текущие после сохранения)
              </p>
              <div className="image-preview">
                {newPreviews.map((src, index) => (
                  <div
                    className={`image-preview-item${dragIndex === index ? ' is-dragging' : ''}${dragOverIndex === index ? ' is-drag-over' : ''}`}
                    key={`${src}-${index}`}
                    draggable
                    onDragStart={(event) => handleDragStart(event, index)}
                    onDragOver={(event) => handleDragOver(event, index)}
                    onDrop={(event) => handleDrop(event, index)}
                    onDragLeave={(event) => handleDragLeave(event, index)}
                    onDragEnd={handleDragEnd}
                  >
                    <img src={src} alt={`Изображение ${index + 1}`} />
                    <button
                      type="button"
                      className="image-preview-remove"
                      onClick={() => handleRemoveNewImage(index)}
                    >
                      Удалить
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
          {status && <p className="status-text">{status}</p>}
          {error && <p className="status-text status-text--error">{error}</p>}
          <div className="button-row">
            <button className="primary-button" type="submit" disabled={isSubmitting}>
              {isSubmitting
                ? 'Сохраняем...'
                : editingId
                ? 'Сохранить изменения'
                : 'Добавить товар'}
            </button>
            {editingId && (
              <button
                className="ghost-button"
                type="button"
                onClick={resetForm}
                disabled={isSubmitting}
              >
                Отменить
              </button>
            )}
          </div>
        </form>
      </div>

      <div className="card">
        <h3>Добавленные товары</h3>
        <div className="admin-list-controls">
          <div className="admin-view-toggle">
            <button
              type="button"
              className={`ghost-button${viewMode === 'grid' ? ' is-active' : ''}`}
              onClick={() => setViewMode('grid')}
            >
              Карточки
            </button>
            <button
              type="button"
              className={`ghost-button${viewMode === 'table' ? ' is-active' : ''}`}
              onClick={() => setViewMode('table')}
            >
              Список
            </button>
          </div>
          <div className="admin-filters">
            <label className="admin-filter">
              <span>Категория</span>
              <select
                value={categoryFilter}
                onChange={(event) => setCategoryFilter(event.target.value)}
              >
                <option value="all">Все категории</option>
                {categories.map((item) => (
                  <option key={item.slug} value={item.slug}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
        {isLoading && <p className="muted">Загрузка списка...</p>}
        {!isLoading && displayedProducts.length === 0 && (
          <p className="muted">
            {products.length === 0 ? 'Пока товаров нет.' : 'Нет товаров для выбранной категории.'}
          </p>
        )}
        {!isLoading && displayedProducts.length > 0 && (
          <>
            <div className={viewMode === 'grid' ? 'products-grid' : 'products-grid is-hidden'}>
              {displayedProducts.map((product) => (
                <article key={product.id} className="product-card">
                  <div className="product-image">
                    {product.images[0] ? (
                      <img src={product.images[0]} alt={product.name} />
                    ) : (
                      <span>Фото</span>
                    )}
                  </div>
                  <div className="product-meta">
                    <h3>{product.name}</h3>
                    <p className="muted">SKU: {product.sku}</p>
                    <p className="price">{formatPriceLabel(product.priceCents)}</p>
                    <p className="stock-text">Остаток: {product.stock}</p>
                    <p className="muted">
                      Вес: {product.weightGrams} г · {product.lengthCm}x{product.widthCm}x{product.heightCm} см
                    </p>
                    {product.isHidden && (
                      <span className="status-badge status-badge--hidden">Скрыт</span>
                    )}
                    {product.description && <p className="muted">{product.description}</p>}
                    {product.showInSlider && (
                      <p className="eyebrow">В слайдере · {product.sliderOrder}</p>
                    )}
                  </div>
                  <div className="button-row">
                    <button
                      type="button"
                      className="admin-edit-button"
                      aria-label="Редактировать товар"
                      onClick={() => handleEdit(product)}
                    >
                      <EditPencilIcon />
                    </button>
                    <button
                      type="button"
                      className="admin-delete-button"
                      aria-label="Удалить товар"
                      onClick={() => handleDelete(product)}
                    >
                      <DeleteCrossIcon />
                    </button>
                  </div>
                </article>
              ))}
            </div>
            <div className={viewMode === 'table' ? 'admin-table-wrap' : 'admin-table-wrap is-hidden'}>
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>Фото</th>
                    <th className="admin-table-name-col">Название</th>
                    <th>Категория</th>
                    <th>SKU</th>
                    <th>Цена</th>
                    <th>Вес и габариты</th>
                    <th
                      className="admin-table-sort-cell"
                      aria-sort={
                        stockSort === 'none'
                          ? 'none'
                          : stockSort === 'asc'
                          ? 'ascending'
                          : 'descending'
                      }
                    >
                      <button
                        type="button"
                        className="admin-table-sort"
                        onClick={handleStockSortToggle}
                      >
                        Остаток
                        <span className="admin-table-sort-icon">
                          <StockSortIcon />
                        </span>
                        {stockSortLabel && (
                          <span className="admin-table-sort-indicator">{stockSortLabel}</span>
                        )}
                      </button>
                    </th>
                    <th>Статус</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {displayedProducts.map((product) => (
                    <tr key={product.id}>
                      <td>
                        <div className="admin-table-thumb">
                          {product.images[0] ? (
                            <img src={product.images[0]} alt={product.name} />
                          ) : (
                            <span>Фото</span>
                          )}
                        </div>
                      </td>
                      <td className="admin-table-name-col">
                        <span className="admin-table-name-text" title={product.name}>
                          {product.name}
                        </span>
                      </td>
                      <td className="muted">
                        {categoryNameBySlug[product.category] ?? product.category}
                      </td>
                      <td className="muted">{product.sku}</td>
                      <td>{formatPriceLabel(product.priceCents)}</td>
                      <td className="muted">
                        {product.weightGrams} г · {product.lengthCm}x{product.widthCm}x{product.heightCm} см
                      </td>
                      <td>{product.stock}</td>
                      <td>
                        {product.isHidden ? (
                          <span className="status-badge status-badge--hidden">Скрыт</span>
                        ) : (
                          <span className="muted">Виден</span>
                        )}
                      </td>
                      <td>
                        <div className="admin-table-actions">
                          <button
                            type="button"
                            className="admin-edit-button"
                            aria-label="Редактировать товар"
                            onClick={() => handleEdit(product)}
                          >
                            <EditPencilIcon />
                          </button>
                          <button
                            type="button"
                            className="admin-delete-button"
                            aria-label="Удалить товар"
                            onClick={() => handleDelete(product)}
                          >
                            <DeleteCrossIcon />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
        </>
      )}
      {activeTab === 'sections' && (
        <div className="card">
          <h3>Категории</h3>
          <p className="form-help">
            Рекомендуется единый стиль: 4:3 (минимум 1200x900), JPG/PNG/WebP, до 5 МБ.
          </p>
          <div className="catalog-sections-list">
            {categories.map((categoryItem) => {
              const editor =
                categorySectionEditors[categoryItem.slug] ??
                createCategorySectionEditorState(categoryItem);
              const previewSrc = editor.removeImage
                ? null
                : editor.imagePreview ?? categoryItem.image;

              return (
                <form
                  key={categoryItem.slug}
                  className="catalog-section-card"
                  onSubmit={(event) => {
                    void handleCategorySectionSubmit(event, categoryItem);
                  }}
                >
                  <button
                    type="button"
                    className="admin-section-delete-button"
                    aria-label="Удалить категорию"
                    onClick={() => openDeleteCategoryModal(categoryItem)}
                    disabled={editor.isSubmitting}
                  >
                    <DeleteCrossIcon />
                  </button>
                  <p className="muted">/catalog/{categoryItem.slug}</p>
                  <div className="form-grid">
                    <label className="field">
                      <span>Название</span>
                      <input
                        type="text"
                        value={editor.name}
                        onChange={(event) =>
                          handleCategorySectionNameChange(
                            categoryItem.slug,
                            event.target.value
                          )
                        }
                        required
                      />
                    </label>
                    <label className="field">
                      <span>URL</span>
                      <input
                        type="text"
                        value={editor.slug}
                        onChange={(event) =>
                          handleCategorySectionSlugChange(
                            categoryItem.slug,
                            event.target.value
                          )
                        }
                        placeholder="kategoriya"
                        required
                      />
                    </label>
                    <label className="field">
                      <span>Фото категории</span>
                      <input
                        type="file"
                        accept="image/*"
                        onChange={(event) =>
                          void handleCategorySectionImageChange(categoryItem.slug, event)
                        }
                      />
                    </label>
                  </div>
                  <p className="muted">Итоговый URL: /catalog/{editor.slug || '...'}</p>

                  <div className="admin-section-preview admin-section-preview--category">
                    {previewSrc ? (
                      <img src={previewSrc} alt={`Превью ${editor.name || categoryItem.slug}`} />
                    ) : (
                      <span>Изображение не загружено</span>
                    )}
                  </div>
                  {previewSrc && (
                    <button
                      type="button"
                      className="admin-section-remove-image"
                      onClick={() => handleCategorySectionImageRemove(categoryItem.slug)}
                      disabled={editor.isSubmitting}
                    >
                      <DeleteCrossIcon />
                      <span>Удалить фото</span>
                    </button>
                  )}

                  {editor.status && <p className="status-text">{editor.status}</p>}
                  {editor.error && <p className="status-text status-text--error">{editor.error}</p>}

                  <div className="button-row">
                    <button
                      className="primary-button"
                      type="submit"
                      disabled={editor.isSubmitting}
                    >
                      {editor.isSubmitting ? 'Сохраняем...' : 'Сохранить'}
                    </button>
                    <button
                      className="ghost-button"
                      type="button"
                      onClick={() => resetCategorySectionDraft(categoryItem)}
                      disabled={editor.isSubmitting}
                    >
                      Сбросить
                    </button>
                  </div>
                </form>
              );
            })}
          </div>
        </div>
      )}
      {activeTab === 'deliveries' && (
        <div className="card">
          <h3>Способы доставки</h3>
          <p className="muted">
            Включайте только те службы доставки, для которых уже настроены ключи и доступы.
          </p>
          {isLoading && <p className="muted">Загрузка списка...</p>}
          {!isLoading && deliveryProviders.length === 0 && (
            <p className="muted">Список служб доставки пока пуст.</p>
          )}
          {!isLoading && deliveryProviders.length > 0 && (
            <div className="delivery-admin-list">
              {deliveryProviders.map((provider) => (
                <label key={provider.key} className="delivery-admin-item">
                  <span className="delivery-admin-item-title">{provider.name}</span>
                  <input
                    type="checkbox"
                    checked={provider.isEnabled}
                    disabled={Boolean(deliveryUpdatingKey)}
                    onChange={(event) => {
                      void handleDeliveryProviderToggle(provider, event.target.checked);
                    }}
                  />
                </label>
              ))}
            </div>
          )}
          {deliveryStatus && <p className="status-text">{deliveryStatus}</p>}
          {deliveryError && <p className="status-text status-text--error">{deliveryError}</p>}
        </div>
      )}
      {activeTab === 'banners' && (
        <div className="card">
          <h3>Баннер главной страницы</h3>
          <form className="admin-form" onSubmit={handleBannerSubmit}>
            <div className="admin-banner-grid">
              <div className="admin-banner-column">
                <p className="muted">Desktop (16:9)</p>
                <div className="admin-banner-preview admin-banner-preview--desktop">
                  {desktopBannerPreview || homeBanner?.desktopImage ? (
                    <img
                      src={desktopBannerPreview ?? homeBanner?.desktopImage ?? ''}
                      alt="Превью desktop-баннера"
                    />
                  ) : (
                    <span>Изображение не загружено</span>
                  )}
                </div>
                <label className="field">
                  <span>Загрузить desktop-баннер</span>
                  <input
                    ref={desktopBannerInputRef}
                    type="file"
                    accept="image/*"
                    onChange={handleDesktopBannerChange}
                  />
                </label>
              </div>

              <div className="admin-banner-column">
                <p className="muted">Mobile (4:3)</p>
                <div className="admin-banner-preview admin-banner-preview--mobile">
                  {mobileBannerPreview || homeBanner?.mobileImage ? (
                    <img
                      src={mobileBannerPreview ?? homeBanner?.mobileImage ?? ''}
                      alt="Превью mobile-баннера"
                    />
                  ) : (
                    <span>Изображение не загружено</span>
                  )}
                </div>
                <label className="field">
                  <span>Загрузить mobile-баннер</span>
                  <input
                    ref={mobileBannerInputRef}
                    type="file"
                    accept="image/*"
                    onChange={handleMobileBannerChange}
                  />
                </label>
              </div>
            </div>

            <p className="form-help">
              Можно загрузить только desktop или только mobile баннер. Не загруженная сторона
              останется без изменений.
            </p>

            {bannerStatus && <p className="status-text">{bannerStatus}</p>}
            {bannerError && <p className="status-text status-text--error">{bannerError}</p>}

            <div className="button-row">
              <button className="primary-button" type="submit" disabled={isBannerSubmitting}>
                {isBannerSubmitting ? 'Сохраняем...' : 'Сохранить баннеры'}
              </button>
              <button
                className="ghost-button"
                type="button"
                onClick={resetBannerForm}
                disabled={isBannerSubmitting}
              >
                Сбросить выбор
              </button>
            </div>
          </form>
        </div>
      )}
      {activeTab === 'fonts' && (
        <div className="card">
          <h3>Оформление шрифтов</h3>
          <div className="stacked-form">
            <label className="field">
              <span>Вариант оформления сайта</span>
              <select value={fontTheme} onChange={handleFontThemeChange}>
                <option value="default">Текущие шрифты</option>
                <option value="franklin">Franklin Gothic (новые)</option>
              </select>
              <span className="form-help">
                Применяется ко всем текущим страницам в этом браузере.
              </span>
            </label>
          </div>
        </div>
      )}
      {activeTab === 'boxes' && (
        <>
          <div className="card">
            <h3>{editingBoxId ? 'Редактирование коробки' : 'Новый тип коробки'}</h3>
            <form className="admin-form" onSubmit={handleBoxSubmit}>
              <div className="form-grid">
                <label className="field">
                  <span>Название</span>
                  <input
                    type="text"
                    placeholder="Например: M"
                    value={boxName}
                    onChange={(event) => setBoxName(event.target.value)}
                    required
                  />
                </label>
                <label className="field">
                  <span>Длина (см)</span>
                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={boxLengthCm}
                    onChange={(event) => setBoxLengthCm(event.target.value)}
                    required
                  />
                </label>
                <label className="field">
                  <span>Ширина (см)</span>
                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={boxWidthCm}
                    onChange={(event) => setBoxWidthCm(event.target.value)}
                    required
                  />
                </label>
                <label className="field">
                  <span>Высота (см)</span>
                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={boxHeightCm}
                    onChange={(event) => setBoxHeightCm(event.target.value)}
                    required
                  />
                </label>
                <label className="field">
                  <span>Макс. вес (г)</span>
                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={boxMaxWeightGrams}
                    onChange={(event) => setBoxMaxWeightGrams(event.target.value)}
                    required
                  />
                </label>
                <label className="field">
                  <span>Вес коробки (г)</span>
                  <input
                    type="number"
                    min="0"
                    step="1"
                    value={boxEmptyWeightGrams}
                    onChange={(event) => setBoxEmptyWeightGrams(event.target.value)}
                    required
                  />
                </label>
                <label className="field">
                  <span>Коэф. заполнения</span>
                  <input
                    type="number"
                    min="0.01"
                    max="1"
                    step="0.01"
                    value={boxFillRatio}
                    onChange={(event) => setBoxFillRatio(event.target.value)}
                    required
                  />
                </label>
                <label className="field">
                  <span>Порядок</span>
                  <input
                    type="number"
                    min="0"
                    step="1"
                    value={boxSortOrder}
                    onChange={(event) => setBoxSortOrder(event.target.value)}
                    required
                  />
                </label>
              </div>
              {boxStatus && <p className="status-text">{boxStatus}</p>}
              {boxError && <p className="status-text status-text--error">{boxError}</p>}
              <div className="button-row">
                <button className="primary-button" type="submit" disabled={isBoxSubmitting}>
                  {isBoxSubmitting
                    ? 'Сохраняем...'
                    : editingBoxId
                    ? 'Сохранить изменения'
                    : 'Добавить тип коробки'}
                </button>
                {editingBoxId && (
                  <button
                    className="ghost-button"
                    type="button"
                    onClick={resetBoxForm}
                    disabled={isBoxSubmitting}
                  >
                    Отменить
                  </button>
                )}
              </div>
            </form>
          </div>

          <div className="card">
            <h3>Настроенные типы коробок</h3>
            {isLoading && <p className="muted">Загрузка списка...</p>}
            {!isLoading && boxTypes.length === 0 && (
              <p className="muted">Типы коробок пока не добавлены.</p>
            )}
            {!isLoading && boxTypes.length > 0 && (
              <div className="admin-table-wrap">
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>Название</th>
                      <th>Габариты</th>
                      <th>Макс. вес</th>
                      <th>Вес коробки</th>
                      <th>Заполнение</th>
                      <th>Порядок</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {boxTypes.map((boxType) => (
                      <tr key={boxType.id}>
                        <td>{boxType.name}</td>
                        <td className="muted">
                          {boxType.lengthCm}x{boxType.widthCm}x{boxType.heightCm} см
                        </td>
                        <td>{boxType.maxWeightGrams} г</td>
                        <td>{boxType.emptyWeightGrams} г</td>
                        <td>{boxType.fillRatio}</td>
                        <td>{boxType.sortOrder}</td>
                        <td>
                          <div className="admin-table-actions">
                            <button
                              type="button"
                              className="admin-edit-button"
                              aria-label="Редактировать тип коробки"
                              onClick={() => handleEditBox(boxType)}
                            >
                              <EditPencilIcon />
                            </button>
                            <button
                              type="button"
                              className="admin-delete-button"
                              aria-label="Удалить тип коробки"
                              onClick={() => handleDeleteBox(boxType)}
                            >
                              <DeleteCrossIcon />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
      {pendingDeleteCategory && (
        <div className="modal-backdrop" onClick={closeDeleteCategoryModal}>
          <div className="modal-card admin-confirm-modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <h3>Удалить раздел?</h3>
              <button
                type="button"
                className="icon-button"
                aria-label="Закрыть"
                onClick={closeDeleteCategoryModal}
                disabled={isCategoryDeleting}
              >
                <DeleteCrossIcon />
              </button>
            </div>
            <p className="muted">
              Вы действительно хотите удалить раздел «{pendingDeleteCategory.name}»?
            </p>
            <p className="muted">
              Если в разделе есть товары, удаление будет заблокировано.
            </p>
            <div className="modal-actions">
              <button
                type="button"
                className="ghost-button"
                onClick={closeDeleteCategoryModal}
                disabled={isCategoryDeleting}
              >
                Отмена
              </button>
              <button
                type="button"
                className="primary-button admin-danger-button"
                onClick={() => void handleConfirmDeleteCategory()}
                disabled={isCategoryDeleting}
              >
                {isCategoryDeleting ? 'Удаляем...' : 'Удалить'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default AdminPage;
