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
            <p className="contacts-inline-link">{STORE_ADDRESS}</p>
          </div>
          <div className="contacts-info-block">
            <p className="eyebrow">Телефон</p>
            <a className="contacts-inline-link" href={STORE_PHONE_HREF}>
              {STORE_PHONE_DISPLAY}
            </a>
            <a className="contacts-inline-link" href={TELEGRAM_LINK} target="_blank" rel="noreferrer">
              Написать в Telegram
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
