#!/bin/sh
# After seed-business.sh, for the EmDash import proof (test/emdash-import.test.ts):
# installs Yoast SEO and the EmDash Exporter plugin on `business`, and gives one
# service a Yoast SEO title. Run inside cli-business:
#   docker compose ... run --rm -T cli-business sh /seed/seed-emdash-exporter.sh

. /seed/seed-common.sh

plugin wordpress-seo "$WPM_YOAST_VERSION"

zip=/tmp/emdash-exporter.zip
wget -q -O "$zip" "https://github.com/emdash-cms/wp-emdash/releases/download/v$WPM_EXPORTER_VERSION/emdash-exporter.zip"
echo "$WPM_EXPORTER_SHA256  $zip" | sha256sum -c -s - || { echo "emdash-exporter.zip: hash mismatch" >&2; exit 1; }
wp plugin install "$zip" --activate --quiet

wp eval '
	$p = get_page_by_path("leak-repair", OBJECT, "service");
	if (!$p) { fwrite(STDERR, "no leak-repair service\n"); exit(1); }
	update_post_meta($p->ID, "_yoast_wpseo_title", "Leak repair in Harbor Light | Same-week visits");
	update_post_meta($p->ID, "_yoast_wpseo_metadesc", "Fast, tidy leak repair for homes on the coast.");
'
