import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, DragEvent, FormEvent } from 'react';
import {
  createBoxType,
  clearAuthToken,
  createProduct,
  deleteBoxType,
  deleteProduct,
  fetchBoxTypes,
  fetchCategories,
  fetchMe,
  fetchProducts,
  getAuthToken,
  requestAuthCode,
  setAuthToken,
  updateBoxType,
  updateProduct,
  verifyAuthCode
} from '../api';
import type { AuthUser, BoxType, Category, Product } from '../api';
import {
  applyFontTheme,
  getStoredFontTheme,
  setStoredFontTheme,
  type FontTheme
} from '../utils/fontTheme';

const MAX_IMAGES = 5;

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
  const [fontTheme, setFontTheme] = useState<FontTheme>(() => getStoredFontTheme());

  const [categories, setCategories] = useState<Category[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [boxTypes, setBoxTypes] = useState<BoxType[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<'products' | 'boxes'>('products');
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
  const fileInputRef = useRef<HTMLInputElement | null>(null);

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
      const [categoryItems, productItems, boxItems] = await Promise.all([
        fetchCategories(),
        fetchProducts({ includeHidden: true }),
        fetchBoxTypes()
      ]);
      setCategories(categoryItems);
      setProducts(productItems);
      setBoxTypes(boxItems);
      setCategory((prev) => prev || categoryItems[0]?.slug || '');
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

  const handleRequestCode = async () => {
    setAuthMessage(null);
    setError(null);
    if (!phone.trim()) {
      setAuthMessage('Введите номер телефона.');
      return;
    }

    setIsSendingCode(true);
    try {
      const result = await requestAuthCode(phone.trim());
      if (result.requiresPassword) {
        setAuthMode('password');
        setAuthMessage('Введите пароль администратора.');
        return;
      }
      setAuthMode('code');
      if (result.code) {
        window.alert(`Тестовый SMS-код: ${result.code}`);
      }
      setAuthMessage('Код отправлен.');
    } catch {
      setAuthMessage('Не удалось отправить код.');
    } finally {
      setIsSendingCode(false);
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
  const activeTabTitle = activeTab === 'products' ? 'Товары' : 'Коробки';
  const activeTabDescription =
    activeTab === 'products'
      ? 'Добавление, редактирование и удаление карточек.'
      : 'Настройка типов коробок для расчёта доставки.';

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
                }}
                required
              />
            </label>
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
          <button className="ghost-button" onClick={handleLogout}>
            Выйти
          </button>
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
              href="#boxes"
              className={`admin-tab-link${activeTab === 'boxes' ? ' is-active' : ''}`}
              onClick={(event) => {
                event.preventDefault();
                setActiveTab('boxes');
              }}
            >
              Коробки
            </a>
          </nav>
          <h1>{activeTabTitle}</h1>
          <p className="muted">{activeTabDescription}</p>
        </div>
        <button className="ghost-button" onClick={handleLogout}>
          Выйти
        </button>
      </header>
      {activeTab === 'products' && (
        <>
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
    </div>
  );
};

export default AdminPage;
