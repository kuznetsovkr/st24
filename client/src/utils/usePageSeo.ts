import { useEffect } from 'react';

const DEFAULT_SITE_URL = 'https://xn---24-3edf.xn--p1ai';
const DEFAULT_OG_IMAGE_PATH = '/android-chrome-512x512.png';

const META_DESCRIPTION_SELECTOR = 'meta[name="description"]';

type JsonLdEntry = Record<string, unknown>;

type PageSeoOptions = {
  canonicalPath?: string;
  canonicalUrl?: string;
  robots?: string;
  ogType?: string;
  ogTitle?: string;
  ogDescription?: string;
  ogImage?: string;
  twitterCard?: string;
  twitterTitle?: string;
  twitterDescription?: string;
  twitterImage?: string;
  jsonLd?: JsonLdEntry | JsonLdEntry[];
};

const resolveSiteUrl = () => {
  const envValue = String(import.meta.env.VITE_SITE_URL ?? '').trim();
  const value = envValue || DEFAULT_SITE_URL;
  return value.replace(/\/+$/, '');
};

export const SITE_URL = resolveSiteUrl();

export const toSiteUrl = (path: string) => {
  if (/^https?:\/\//i.test(path)) {
    return path;
  }
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return new URL(normalizedPath, `${SITE_URL}/`).toString();
};

const getOrCreateMetaByName = (name: string) => {
  let tag = document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
  if (!tag) {
    tag = document.createElement('meta');
    tag.setAttribute('name', name);
    document.head.appendChild(tag);
  }
  return tag;
};

const getOrCreateMetaByProperty = (property: string) => {
  let tag = document.querySelector<HTMLMetaElement>(`meta[property="${property}"]`);
  if (!tag) {
    tag = document.createElement('meta');
    tag.setAttribute('property', property);
    document.head.appendChild(tag);
  }
  return tag;
};

const getOrCreateCanonicalLink = () => {
  let link = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (!link) {
    link = document.createElement('link');
    link.setAttribute('rel', 'canonical');
    document.head.appendChild(link);
  }
  return link;
};

const removeManagedJsonLd = () => {
  const scripts = document.querySelectorAll('script[data-seo-jsonld="true"]');
  scripts.forEach((script) => script.remove());
};

export const usePageSeo = (
  title: string,
  description: string,
  options?: PageSeoOptions
) => {
  const jsonLdDependency = JSON.stringify(options?.jsonLd ?? null);

  useEffect(() => {
    const canonicalHref = options?.canonicalUrl
      ? toSiteUrl(options.canonicalUrl)
      : toSiteUrl(options?.canonicalPath ?? window.location.pathname);
    const robots = options?.robots ?? 'index,follow';
    const ogTitle = options?.ogTitle ?? title;
    const ogDescription = options?.ogDescription ?? description;
    const ogImage = toSiteUrl(options?.ogImage ?? DEFAULT_OG_IMAGE_PATH);
    const ogType = options?.ogType ?? 'website';
    const twitterCard = options?.twitterCard ?? 'summary_large_image';
    const twitterTitle = options?.twitterTitle ?? ogTitle;
    const twitterDescription = options?.twitterDescription ?? ogDescription;
    const twitterImage = toSiteUrl(options?.twitterImage ?? ogImage);

    document.title = title;

    const descriptionMeta = document.querySelector<HTMLMetaElement>(META_DESCRIPTION_SELECTOR);
    (descriptionMeta ?? getOrCreateMetaByName('description')).setAttribute('content', description);

    getOrCreateCanonicalLink().setAttribute('href', canonicalHref);
    getOrCreateMetaByName('robots').setAttribute('content', robots);

    getOrCreateMetaByProperty('og:title').setAttribute('content', ogTitle);
    getOrCreateMetaByProperty('og:description').setAttribute('content', ogDescription);
    getOrCreateMetaByProperty('og:type').setAttribute('content', ogType);
    getOrCreateMetaByProperty('og:url').setAttribute('content', canonicalHref);
    getOrCreateMetaByProperty('og:image').setAttribute('content', ogImage);
    getOrCreateMetaByProperty('og:site_name').setAttribute('content', 'СТ-24');

    getOrCreateMetaByName('twitter:card').setAttribute('content', twitterCard);
    getOrCreateMetaByName('twitter:title').setAttribute('content', twitterTitle);
    getOrCreateMetaByName('twitter:description').setAttribute('content', twitterDescription);
    getOrCreateMetaByName('twitter:image').setAttribute('content', twitterImage);

    removeManagedJsonLd();
    const jsonLdEntries = options?.jsonLd
      ? Array.isArray(options.jsonLd)
        ? options.jsonLd
        : [options.jsonLd]
      : [];
    jsonLdEntries.forEach((entry) => {
      const script = document.createElement('script');
      script.type = 'application/ld+json';
      script.dataset.seoJsonld = 'true';
      script.text = JSON.stringify(entry);
      document.head.appendChild(script);
    });
  }, [
    description,
    jsonLdDependency,
    options?.canonicalPath,
    options?.canonicalUrl,
    options?.ogDescription,
    options?.ogImage,
    options?.ogTitle,
    options?.ogType,
    options?.robots,
    options?.twitterCard,
    options?.twitterDescription,
    options?.twitterImage,
    options?.twitterTitle,
    title
  ]);
};
