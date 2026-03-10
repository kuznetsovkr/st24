import { query } from '../db';

export type SiteBannerRow = {
  key: string;
  desktop_image: string | null;
  mobile_image: string | null;
  created_at: string;
  updated_at: string;
};

export const getHomeBanner = async (): Promise<SiteBannerRow | null> => {
  const result = await query(
    `
      SELECT key, desktop_image, mobile_image, created_at, updated_at
      FROM site_banners
      WHERE key = 'home'
      LIMIT 1;
    `
  );
  return (result.rows[0] as SiteBannerRow | undefined) ?? null;
};

export const updateHomeBanner = async (input: {
  desktopImage?: string | null;
  mobileImage?: string | null;
}): Promise<SiteBannerRow> => {
  const result = await query(
    `
      INSERT INTO site_banners (key, desktop_image, mobile_image)
      VALUES ('home', $1, $2)
      ON CONFLICT (key) DO UPDATE
      SET desktop_image = COALESCE($1, site_banners.desktop_image),
          mobile_image = COALESCE($2, site_banners.mobile_image),
          updated_at = NOW()
      RETURNING key, desktop_image, mobile_image, created_at, updated_at;
    `,
    [input.desktopImage ?? null, input.mobileImage ?? null]
  );

  return result.rows[0] as SiteBannerRow;
};
