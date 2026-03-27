-- Clear ads column on TikTok-sourced entries — platform fee was incorrectly
-- written to ads. It now goes to platform_fee column instead.
update public.entries set ads = 0 where source = 'tiktok' and ads != 0;
