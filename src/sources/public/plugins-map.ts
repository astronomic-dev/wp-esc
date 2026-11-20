// Common plugin folder names (wp-content/plugins/<slug>) mapped to a name and category.
// Unknown slugs get category "other". `stores` says what plugin-owned data a WordPress
// export does not carry, for storedElsewhere. `namespaces` are REST namespaces that
// show the plugin is active even when it has no front-end files.

import type { PluginCategory } from "../../contracts/inventory.ts";

export interface PluginInfo { name: string; category: PluginCategory; stores?: string; namespaces?: string[] }

export const PLUGINS: Record<string, PluginInfo> = {
	// SEO
	"wordpress-seo": { name: "Yoast SEO", category: "seo", namespaces: ["yoast/v1"] },
	"wordpress-seo-premium": { name: "Yoast SEO Premium", category: "seo" },
	"seo-by-rank-math": { name: "Rank Math SEO", category: "seo", namespaces: ["rankmath/v1"] },
	"all-in-one-seo-pack": { name: "All in One SEO", category: "seo", namespaces: ["aioseo/v1"] },
	"autodescription": { name: "The SEO Framework", category: "seo" },
	"wp-seopress": { name: "SEOPress", category: "seo" },
	// Forms
	"contact-form-7": { name: "Contact Form 7", category: "forms", namespaces: ["contact-form-7/v1"] },
	"flamingo": { name: "Flamingo", category: "form-storage", stores: "Contact Form 7 messages" },
	"wpforms-lite": { name: "WPForms Lite", category: "forms" },
	"wpforms": { name: "WPForms Pro", category: "form-storage", stores: "form entries" },
	"gravityforms": { name: "Gravity Forms", category: "form-storage", stores: "form entries", namespaces: ["gf/v2"] },
	"ninja-forms": { name: "Ninja Forms", category: "form-storage", stores: "form submissions" },
	"formidable": { name: "Formidable Forms", category: "form-storage", stores: "form entries" },
	"fluentform": { name: "Fluent Forms", category: "form-storage", stores: "form entries" },
	"forminator": { name: "Forminator", category: "form-storage", stores: "form submissions" },
	// Store
	"woocommerce": { name: "WooCommerce", category: "store", stores: "orders, customers and coupons", namespaces: ["wc/v3", "wc/store/v1"] },
	"easy-digital-downloads": { name: "Easy Digital Downloads", category: "store", stores: "orders and customers" },
	"woocommerce-subscriptions": { name: "WooCommerce Subscriptions", category: "store", stores: "subscriptions" },
	// Members and courses
	"memberpress": { name: "MemberPress", category: "members", stores: "members and transactions" },
	"paid-memberships-pro": { name: "Paid Memberships Pro", category: "members", stores: "members and orders" },
	"restrict-content-pro": { name: "Restrict Content Pro", category: "members", stores: "memberships" },
	"ultimate-member": { name: "Ultimate Member", category: "members", stores: "member profiles" },
	"buddypress": { name: "BuddyPress", category: "members", stores: "profiles, groups and activity", namespaces: ["buddypress/v1"] },
	"sfwd-lms": { name: "LearnDash", category: "courses", stores: "course progress and quiz results" },
	"lifterlms": { name: "LifterLMS", category: "courses", stores: "enrollments and progress" },
	"learnpress": { name: "LearnPress", category: "courses", stores: "enrollments and progress" },
	"tutor": { name: "Tutor LMS", category: "courses", stores: "enrollments and progress" },
	// Builders
	"elementor": { name: "Elementor", category: "builder", namespaces: ["elementor/v1"] },
	"elementor-pro": { name: "Elementor Pro", category: "builder" },
	"beaver-builder-lite-version": { name: "Beaver Builder", category: "builder" },
	"bb-plugin": { name: "Beaver Builder Pro", category: "builder" },
	"js_composer": { name: "WPBakery Page Builder", category: "builder" },
	"divi-builder": { name: "Divi Builder", category: "builder" },
	"oxygen": { name: "Oxygen", category: "builder" },
	"breakdance": { name: "Breakdance", category: "builder" },
	"brizy": { name: "Brizy", category: "builder" },
	"siteorigin-panels": { name: "SiteOrigin Page Builder", category: "builder" },
	"kadence-blocks": { name: "Kadence Blocks", category: "builder" },
	"spectra": { name: "Spectra", category: "builder" },
	"ultimate-addons-for-gutenberg": { name: "Spectra", category: "builder" },
	"stackable-ultimate-gutenberg-blocks": { name: "Stackable", category: "builder" },
	// Fields
	"advanced-custom-fields": { name: "Advanced Custom Fields", category: "fields", namespaces: ["acf/v3"] },
	"advanced-custom-fields-pro": { name: "Advanced Custom Fields Pro", category: "fields" },
	"secure-custom-fields": { name: "Secure Custom Fields", category: "fields" },
	"meta-box": { name: "Meta Box", category: "fields" },
	"pods": { name: "Pods", category: "fields", namespaces: ["pods/v1"] },
	"custom-post-type-ui": { name: "Custom Post Type UI", category: "fields" },
	// Cache and speed
	"wp-rocket": { name: "WP Rocket", category: "cache" },
	"w3-total-cache": { name: "W3 Total Cache", category: "cache" },
	"wp-super-cache": { name: "WP Super Cache", category: "cache" },
	"litespeed-cache": { name: "LiteSpeed Cache", category: "cache" },
	"autoptimize": { name: "Autoptimize", category: "cache" },
	"wp-fastest-cache": { name: "WP Fastest Cache", category: "cache" },
	// Security
	"wordfence": { name: "Wordfence", category: "security" },
	"better-wp-security": { name: "Solid Security", category: "security" },
	"sucuri-scanner": { name: "Sucuri Security", category: "security" },
	// Analytics
	"google-site-kit": { name: "Site Kit by Google", category: "analytics" },
	"google-analytics-for-wordpress": { name: "MonsterInsights", category: "analytics" },
	"jetpack": { name: "Jetpack", category: "other", namespaces: ["jetpack/v4"] },
	// Comments
	"akismet": { name: "Akismet", category: "comments" },
	"disqus-comment-system": { name: "Disqus", category: "comments" },
	"wpdiscuz": { name: "wpDiscuz", category: "comments" },
	// Search
	"relevanssi": { name: "Relevanssi", category: "search" },
	"searchwp": { name: "SearchWP", category: "search" },
	"elasticpress": { name: "ElasticPress", category: "search" },
	// Media
	"smush": { name: "Smush", category: "media" },
	"wp-smushit": { name: "Smush", category: "media" },
	"envira-gallery-lite": { name: "Envira Gallery", category: "media" },
	"nextgen-gallery": { name: "NextGEN Gallery", category: "media", stores: "gallery tables" },
	"modula-best-grid-gallery": { name: "Modula", category: "media" },
	// Multilingual
	"sitepress-multilingual-cms": { name: "WPML", category: "multilingual" },
	"polylang": { name: "Polylang", category: "multilingual" },
	"translatepress-multilingual": { name: "TranslatePress", category: "multilingual", stores: "translation tables" },
	"weglot": { name: "Weglot", category: "multilingual", stores: "translations kept by the Weglot service" },
	// Redirects
	"redirection": { name: "Redirection", category: "redirects", stores: "redirect rules and logs", namespaces: ["redirection/v1"] },
	"safe-redirect-manager": { name: "Safe Redirect Manager", category: "redirects" },
	"simple-301-redirects": { name: "Simple 301 Redirects", category: "redirects", stores: "redirect rules" },
};

/** The plugin for a REST namespace, if one is known. */
export function pluginForNamespace(ns: string): string | undefined {
	for (const [slug, info] of Object.entries(PLUGINS)) if (info.namespaces?.includes(ns)) return slug;
	return undefined;
}
