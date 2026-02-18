import { useEffect, useMemo, useRef, useState } from 'react';

const MAP_CONTAINER_ID = 'contacts-map';
const MAP_SCRIPT_ID = 'yandex-maps-script';
const STORE_COORDS: [number, number] = [56.03685, 92.789874];
const STORE_ADDRESS = 'Красноярск, улица Калинина, 53а/1';
const STORE_PHONE_DISPLAY = '+7 995 908-95-97';
const STORE_PHONE_HREF = 'tel:+79959089597';
const TELEGRAM_LINK = 'https://t.me/+79959089597';
const TWO_GIS_REVIEWS_LINK = 'https://go.2gis.com/jyqVa';
const MAP_ZOOM = 17;

type YandexMapsApi = {
  ready: (callback: () => void) => void;
  Map: new (
    container: string | HTMLElement,
    state: Record<string, unknown>,
    options?: Record<string, unknown>
  ) => {
    destroy: () => void;
    geoObjects: { add: (item: unknown) => void };
    behaviors: {
      disable: (name: string | string[]) => void;
      enable: (name: string | string[]) => void;
    };
  };
  Placemark: new (
    coordinates: [number, number],
    properties?: Record<string, unknown>,
    options?: Record<string, unknown>
  ) => unknown;
};

type YandexWindow = Window & { ymaps?: YandexMapsApi };


const TelegramIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 50 50" width="16" height="16" fill="currentColor" aria-hidden="true">
    <path d="M19.44 2.64 C30.53 -0.38 43.06 6.38 46.68 17.26 C49.36 24.52 47.95 33.06 43.17 39.13 C38.50 45.22 30.62 48.68 22.97 47.93 C15.48 47.33 8.47 42.77 4.88 36.18 C1.13 29.59 1.00 21.13 4.54 14.44 C7.51 8.61 13.08 4.20 19.44 2.64 M 20.41 4.54 C13.15 6.12 6.98 11.85 4.92 18.99 C2.65 26.19 4.79 34.53 10.18 39.79 C15.44 45.17 23.78 47.37 30.97 45.07 C37.61 43.18 43.08 37.71 45.04 31.09 C47.36 23.88 45.22 15.52 39.84 10.22 C34.91 5.17 27.29 2.91 20.41 4.54 Z" />
    <path d="M19.63 19.57 C24.09 17.84 28.34 15.56 32.93 14.19 C35.30 13.18 38.02 15.42 37.38 17.95 C36.75 23.64 36.01 29.35 34.70 34.93 C34.33 37.09 32.27 39.19 29.95 38.10 C25.98 36.17 21.96 33.83 19.28 30.23 C16.07 30.27 12.62 30.05 9.91 28.13 C8.53 27.16 8.61 24.89 10.01 23.99 C12.94 21.98 16.42 21.02 19.63 19.57 M 24.02 19.98 C19.52 22.13 14.44 23.25 10.50 26.43 C12.91 27.09 15.41 28.65 17.95 28.05 C22.18 26.05 25.59 22.64 29.88 20.73 C27.45 24.10 23.93 26.47 21.53 29.86 C24.46 32.90 28.17 35.10 32.09 36.60 C33.46 31.49 34.23 26.26 34.99 21.03 C35.10 19.39 35.65 17.62 34.91 16.05 C31.01 16.42 27.64 18.65 24.02 19.98 Z" />
  </svg>
);

const PhoneIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
    <path d="m23.5,11c-.276,0-.5-.224-.5-.5,0-5.238-4.262-9.5-9.5-9.5-.276,0-.5-.224-.5-.5s.224-.5.5-.5c5.79,0,10.5,4.71,10.5,10.5,0,.276-.224,.5-.5,.5Zm-3.5-.5c0-3.584-2.916-6.5-6.5-6.5-.276,0-.5.224-.5.5s.224.5.5.5c3.033,0,5.5,2.467,5.5,5.5,0,.276.224.5.5.5s.5-.224.5-.5Zm2.234,11.771l.978-1.125c.508-.508.788-1.184.788-1.902s-.28-1.395-.837-1.945l-2.446-1.873c-1.048-1.048-2.753-1.049-3.803-.003l-1.532,1.494c-3.68-1.499-6.678-4.5-8.294-8.303l1.488-1.525c1.049-1.049,1.049-2.756.043-3.756l-1.959-2.543c-1.017-1.017-2.813-.993-3.78-.023l-1.174,1.024C.605,2.886,0,4.373,0,5.976c0,7.749,10.275,18.024,18.024,18.024,1.603,0,3.089-.605,4.21-1.729ZM5.909,1.446l1.959,2.543c.659.659.659,1.732-.004,2.396l-1.722,1.766c-.138.142-.18.352-.106.536,1.729,4.305,5.113,7.688,9.286,9.28.182.07.388.027.527-.108l1.766-1.722s.003-.003.004-.005c.639-.64,1.704-.681,2.44.043l2.446,1.873c.659.659.659,1.731-.023,2.416l-.979,1.125c-.908.91-2.144,1.411-3.479,1.411C10.864,23,1,13.136,1,5.976c0-1.335.501-2.571,1.387-3.456l1.175-1.025c.336-.336.779-.5,1.215-.5.419,0,.831.152,1.133.452Z" />
  </svg>
);

const ContactsPage = () => {
  const mapRef = useRef<InstanceType<YandexMapsApi['Map']> | null>(null);
  const [mapError, setMapError] = useState<string | null>(null);
  const apiKey = import.meta.env.VITE_YANDEX_MAPS_API_KEY;

  const mapLink = useMemo(() => {
    const [lat, lon] = STORE_COORDS;
    return `https://yandex.ru/maps/?ll=${lon}%2C${lat}&z=${MAP_ZOOM}&pt=${lon},${lat},pm2blk`;
  }, []);

  useEffect(() => {
    const key = typeof apiKey === 'string' ? apiKey.trim() : '';
    if (!key) {
      setMapError('Для отображения карты добавьте VITE_YANDEX_MAPS_API_KEY в client/.env.');
      return;
    }

    let disposed = false;
    let script = document.getElementById(MAP_SCRIPT_ID) as HTMLScriptElement | null;

    const getYandex = () => (window as YandexWindow).ymaps;

    const destroyMap = () => {
      if (mapRef.current) {
        mapRef.current.destroy();
        mapRef.current = null;
      }
    };

    const initMap = () => {
      const ymaps = getYandex();
      if (!ymaps) {
        if (!disposed) {
          setMapError('Не удалось инициализировать Яндекс.Карты.');
        }
        return;
      }

      ymaps.ready(() => {
        if (disposed) {
          return;
        }

        destroyMap();

        const map = new ymaps.Map(
          MAP_CONTAINER_ID,
          {
            center: STORE_COORDS,
            zoom: MAP_ZOOM,
            controls: ['zoomControl']
          },
          { suppressMapOpenBlock: true }
        );

        const placemark = new ymaps.Placemark(
          STORE_COORDS,
          {
            balloonContentHeader: 'Магазин',
            balloonContentBody: STORE_ADDRESS
          },
          {
            iconColor: '#000000'
          }
        );

        map.geoObjects.add(placemark);
        map.behaviors.enable('scrollZoom');
        mapRef.current = map;
        setMapError(null);
      });
    };

    const handleLoad = () => {
      if (script) {
        script.dataset.loaded = 'true';
      }
      initMap();
    };

    const handleError = () => {
      if (!disposed) {
        setMapError('Не удалось загрузить скрипт Яндекс.Карт.');
      }
    };

    if ((window as YandexWindow).ymaps) {
      initMap();
    } else {
      if (!script) {
        script = document.createElement('script');
        script.id = MAP_SCRIPT_ID;
        script.src = `https://api-maps.yandex.ru/2.1/?apikey=${key}&lang=ru_RU`;
        script.async = true;
        script.defer = true;
        document.head.appendChild(script);
      }

      if (script.dataset.loaded === 'true') {
        initMap();
      } else {
        script.addEventListener('load', handleLoad);
        script.addEventListener('error', handleError);
      }
    }

    return () => {
      disposed = true;
      if (script) {
        script.removeEventListener('load', handleLoad);
        script.removeEventListener('error', handleError);
      }
      destroyMap();
    };
  }, [apiKey]);

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">Контакты</p>
          <h1>Как нас найти</h1>
        </div>
      </header>

      <section className="card contacts-info-card">
        <div className="contacts-info-grid">
          <div className="contacts-info-block">
            <p className="eyebrow">Адрес</p>
            <p className="contacts-inline-link contacts-link-with-icon">
              <span>{STORE_ADDRESS}</span>
            </p>
          </div>
          <div className="contacts-info-block">
            <p className="eyebrow">Телефон</p>
            <a className="contacts-inline-link contacts-link-with-icon" href={STORE_PHONE_HREF}>
              <span className="contacts-inline-icon" aria-hidden="true">
                <PhoneIcon />
              </span>
              <span>{STORE_PHONE_DISPLAY}</span>
            </a>
            <a
              className="contacts-inline-link contacts-link-with-icon"
              href={TELEGRAM_LINK}
              target="_blank"
              rel="noreferrer"
            >
              <span className="contacts-inline-icon contacts-inline-icon--telegram" aria-hidden="true">
                <TelegramIcon />
              </span>
              <span>Написать в Telegram</span>
            </a>
          </div>

          <div className="contacts-info-block">
            <p className="eyebrow">Режим работы</p>
            <p className="contacts-hours-item">Пн — Пт 10:00–19:00</p>
            <p className="contacts-hours-item">Суббота 10:00–16:00</p>
            <p className="contacts-hours-item">Воскресенье выходной</p>
          </div>
        </div>
      </section>

      <section className="card contacts-map-card">
        <div id={MAP_CONTAINER_ID} className="contacts-map" />
        {mapError ? <p className="status-text status-text--error">{mapError}</p> : null}
        <div className="contacts-map-actions">
          <a className="link-button contacts-map-link" href={mapLink} target="_blank" rel="noreferrer">
            Открыть карту в Яндекс
          </a>
          <a className="link-button contacts-map-link" href={TWO_GIS_REVIEWS_LINK} target="_blank" rel="noreferrer">
            Читать отзывы в 2ГИС
          </a>
        </div>
      </section>

      <section className="card contacts-note-list">
        <p>
          Интернет-магазин работает круглосуточно для оформления заказов. Обработка заказов производится ежедневно.
          Служба поддержки и прием заказов по телефону к вашим услугам с Пн — Пт 10:00–19:00 и в субботу 10:00–16:00,
          воскресенье — выходной (время красноярское). В остальное время вы можете связаться с нами по почте
          store@cleanshop.ru, в Telegram или отправив запрос.
        </p>
        <p>
          Информация о юридическом лице: Контакт Интернейшнл АО, ИНН 7816086580, ОГРН 1027808008865, юридический адрес:
          191025, Санкт-Петербург, Невский пр. 108, литера А, 23-Н.
        </p>
      </section>
    </div>
  );
};

export default ContactsPage;
