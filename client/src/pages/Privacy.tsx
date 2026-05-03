import { useEffect, useMemo, useState } from 'react';
import { type PrivacyPolicyMeta, fetchPrivacyPolicyMeta } from '../api.ts';
import { STORE_EMAIL, STORE_EMAIL_HREF } from '../constants/contacts.ts';
import { usePageSeo } from '../utils/usePageSeo.ts';

const PRIVACY_DOC_URL = '/docs/privacy-policy.pdf';
const DEFAULT_POLICY_VERSION = '2026-05-03';

const OPERATOR_NAME = 'ИП Булуков Александр Владимирович';
const OPERATOR_INN = '246009729921';
const OPERATOR_OGRNIP = '321246800146178';
const OPERATOR_ADDRESS = 'г. Красноярск, ул. Калинина, 53а';

const FALLBACK_POLICY_META: PrivacyPolicyMeta = {
  version: DEFAULT_POLICY_VERSION,
  effectiveDate: DEFAULT_POLICY_VERSION
};

const formatPolicyDate = (value: string) => {
  const normalized = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    return normalized;
  }
  const [year, month, day] = normalized.split('-');
  return `${day}.${month}.${year}`;
};

const normalizePolicyMeta = (meta: Partial<PrivacyPolicyMeta> | null | undefined): PrivacyPolicyMeta => {
  const version = (meta?.version ?? '').trim() || DEFAULT_POLICY_VERSION;
  const effectiveDate = (meta?.effectiveDate ?? '').trim() || version;
  return { version, effectiveDate };
};

const PrivacyPage = () => {
  const [policyMeta, setPolicyMeta] = useState<PrivacyPolicyMeta>(FALLBACK_POLICY_META);

  usePageSeo(
    'Политика обработки персональных данных | СТ-24',
    'Актуальная политика обработки персональных данных интернет-магазина СТ-24 со ссылкой на PDF-версию документа.'
  );

  useEffect(() => {
    let isActive = true;

    void fetchPrivacyPolicyMeta()
      .then((meta) => {
        if (!isActive) {
          return;
        }
        setPolicyMeta(normalizePolicyMeta(meta));
      })
      .catch(() => {
        if (!isActive) {
          return;
        }
        setPolicyMeta(FALLBACK_POLICY_META);
      });

    return () => {
      isActive = false;
    };
  }, []);

  const effectiveDate = useMemo(
    () => formatPolicyDate(policyMeta.effectiveDate),
    [policyMeta.effectiveDate]
  );

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">Юридическая информация</p>
          <h1>Политика обработки персональных данных</h1>
          <p className="muted">
            Редакция {policyMeta.version} от {effectiveDate}. Документ действует для всех форм сайта и личного
            кабинета.
          </p>
        </div>
      </header>

      <div className="card">
        <div className="legal-doc-actions">
          <a
            href={PRIVACY_DOC_URL}
            className="link-button legal-doc-download"
            target="_blank"
            rel="noopener noreferrer"
          >
            Открыть PDF в новой вкладке
          </a>
          <a href={PRIVACY_DOC_URL} className="link-button legal-doc-download" download>
            Скачать PDF
          </a>
        </div>

        <div className="legal-doc-meta">
          <span className="legal-doc-badge">Версия: {policyMeta.version}</span>
          <span>Дата вступления в силу: {effectiveDate}</span>
        </div>

        <div className="legal-doc-content">
          <section className="legal-doc-section">
            <h2>1. Нормативная база</h2>
            <p>
              Настоящая политика разработана в соответствии с Федеральным законом от 27.07.2006 № 152-ФЗ «О
              персональных данных», Федеральным законом от 27.07.2006 № 149-ФЗ «Об информации, информационных
              технологиях и о защите информации» и иными применимыми нормативными актами РФ.
            </p>
            <p>
              Оператор соблюдает требование локализации баз данных на территории РФ (ч. 5 ст. 18 152-ФЗ) и
              применяет организационные и технические меры защиты персональных данных.
            </p>
          </section>

          <section className="legal-doc-section">
            <h2>2. Оператор персональных данных</h2>
            <ul className="legal-doc-bullets">
              <li>{OPERATOR_NAME}</li>
              <li>ИНН: {OPERATOR_INN}</li>
              <li>ОГРНИП: {OPERATOR_OGRNIP}</li>
              <li>Адрес: {OPERATOR_ADDRESS}</li>
              <li>
                Email для обращений субъектов ПДн: <a href={STORE_EMAIL_HREF}>{STORE_EMAIL}</a>
              </li>
            </ul>
          </section>

          <section className="legal-doc-section">
            <h2>3. Какие данные обрабатываются</h2>
            <ul className="legal-doc-bullets">
              <li>Данные из форм заказа и обратной связи: ФИО, телефон, email, адрес/пункт выдачи.</li>
              <li>Данные B2B-заявок: контактные данные, реквизиты и файлы, приложенные пользователем.</li>
              <li>Данные, связанные с оплатой: идентификаторы платежей и статус транзакций.</li>
              <li>
                Технические данные: IP-адрес, user-agent, cookies, CSRF-токен, метки времени и служебные журналы.
              </li>
              <li>Данные, переданные в запросах «Нужна запчасть» и иных пользовательских обращениях.</li>
            </ul>
          </section>

          <section className="legal-doc-section">
            <h2>4. Цели и правовые основания обработки</h2>
            <ul className="legal-doc-bullets">
              <li>Заключение и исполнение договора купли-продажи (оферты), доставка и постпродажное сопровождение.</li>
              <li>Идентификация пользователя, подтверждение действий и защита личного кабинета.</li>
              <li>Обработка обращений, претензий и запросов от клиентов и контрагентов.</li>
              <li>Выполнение требований законодательства РФ о бухгалтерском и налоговом учете.</li>
              <li>Обеспечение безопасности сайта, предотвращение мошенничества и злоупотреблений.</li>
            </ul>
            <p>
              Основания обработки: согласие субъекта ПДн, исполнение договора, законный интерес оператора и
              обязанности, предусмотренные законодательством РФ.
            </p>
          </section>

          <section className="legal-doc-section">
            <h2>5. Передача данных третьим лицам</h2>
            <p>
              Данные передаются только в объеме, необходимом для оказания услуг и исполнения договора, в том числе
              следующим обработчикам/получателям:
            </p>
            <ul className="legal-doc-bullets">
              <li>ЮKassa - обработка и подтверждение платежей.</li>
              <li>Службы доставки (СДЭК, Деловые Линии, Почта России) - оформление и доставка заказов.</li>
              <li>ООО «СМС.РУ» и Telegram Gateway - отправка кодов подтверждения и сервисных уведомлений.</li>
              <li>Яндекс Карты - отображение карты и адресной информации на странице контактов.</li>
              <li>Cloudflare Turnstile - защита форм от автоматических запросов.</li>
            </ul>
            <p>
              При использовании отдельных сервисов возможна трансграничная передача технических данных. Такая
              передача осуществляется только при наличии правовых оснований, предусмотренных ст. 12 152-ФЗ.
            </p>
          </section>

          <section className="legal-doc-section">
            <h2>6. Сроки обработки и хранение</h2>
            <p>
              Персональные данные обрабатываются не дольше, чем этого требуют цели обработки и требования
              законодательства. По достижении целей данные удаляются, уничтожаются либо обезличиваются, если иное не
              предусмотрено законом.
            </p>
          </section>

          <section className="legal-doc-section">
            <h2>7. Права субъекта персональных данных</h2>
            <ul className="legal-doc-bullets">
              <li>Запросить сведения об обработке своих ПДн и получить копию данных.</li>
              <li>Требовать уточнения, блокирования или удаления недостоверных/избыточных данных.</li>
              <li>Отозвать согласие на обработку персональных данных.</li>
              <li>Обжаловать действия оператора в Роскомнадзор или в судебном порядке.</li>
            </ul>
            <p>
              Обращения принимаются по адресу <a href={STORE_EMAIL_HREF}>{STORE_EMAIL}</a>. В теме письма укажите:
              «Персональные данные».
            </p>
          </section>

          <section className="legal-doc-section">
            <h2>8. Дополнительные условия</h2>
            <ul className="legal-doc-bullets">
              <li>Согласие на обработку ПДн фиксируется в формах сайта и хранится в журналах оператора.</li>
              <li>
                Публикация фотографий сотрудников и иных физических лиц на сайте допускается только при наличии
                отдельного согласия соответствующего субъекта.
              </li>
              <li>Новая редакция политики вступает в силу с даты публикации на этой странице.</li>
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
};

export default PrivacyPage;
