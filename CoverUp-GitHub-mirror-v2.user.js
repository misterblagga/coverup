// ==UserScript==
// @name         CoverUp
// @version      9.1.17
// @description  Rehost RED Album & Artist Covers: intelligent quality detection, multi-source artwork picker (Discogs, MusicBrainz, Apple Music, Qobuz, Bandcamp, Deezer, Tidal), smart alt-cover management, and upload to RED image host/imgbb/catbox/TheSunGod/custom hosts.
// @match        https://redacted.sh/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// @connect      api.discogs.com
// @connect      i.discogs.com
// @connect      redacted.sh
// @connect      api.imgbb.com
// @connect      i.ibb.co
// @connect      catbox.moe
// @connect      files.catbox.moe
// @connect      itunes.apple.com
// @connect      is1-ssl.mzstatic.com
// @connect      is2-ssl.mzstatic.com
// @connect      is3-ssl.mzstatic.com
// @connect      is4-ssl.mzstatic.com
// @connect      is5-ssl.mzstatic.com
// @connect      api.deezer.com
// @connect      cdn-images.dzcdn.net
// @connect      f4.bcbits.com
// @connect      bandcamp.com
// @connect      open.spotify.com
// @connect      i.scdn.co
// @connect      geo-media.beatport.com
// @connect      api.beatport.com
// @connect      beatport.com
// @connect      coverartarchive.org
// @connect      musicbrainz.org
// @connect      amazon.com
// @connect      m.media-amazon.com
// @connect      api.qobuz.com
// @connect      archive.org
// @connect      open.qobuz.com
// @connect      static.qobuz.com
// @connect      thesungod.xyz
// @connect      cdn.thesungod.xyz
// @connect      images.redacted.sh
// @connect      i.imgur.com
// @connect      imgur.com
// @connect      pixhost.to
// @connect      img.pixhost.to
// @connect      *
// @license      MIT
// @namespace    https://github.com/misterblagga/coverup
// @downloadURL https://raw.githubusercontent.com/misterblagga/coverup/main/CoverUp.user.js
// @updateURL https://raw.githubusercontent.com/misterblagga/coverup/main/CoverUp.user.js
// ==/UserScript==




(function() {
    'use strict';

    // --- CONFIGURATION ---
    const MAX_DIMENSION   = 3000;
    const JPEG_QUALITY    = 0.95;
    const MIN_RESOLUTION  = 500;
    // How small an image actually has to be (in px, either dimension) before the
    // RED-thumbnail "upgrade to full size?" prompt is worth showing. Plenty of /t/
    // URLs already display at a perfectly reasonable size — only nag about the ones
    // that are genuinely tiny.
    const TINY_THUMBNAIL_MAX = 150;
    const REHOST_TRIGGERS = ['imgur.com', 'ptpimg.me', 'pixhost.to', 'img.pixhost.to'];
    // Domains that are valid permanent rehost destinations — images already here are "done"
    const REHOST_DOMAINS = [
        'imgbb.com', 'i.imgbb.com', 'ibb.co',
        'catbox.moe', 'files.catbox.moe',
        'ra.thesungod.xyz',
        'images.redacted.sh', 'redacted.sh',
    ];
    // Source domains that produce temporary/expiring URLs — rehost recommended even if image loads fine
    const SOURCE_DOMAINS = [
        'i.discogs.com', 'coverartarchive.org', 'archive.org',
        'musicbrainz.org', 'lastfm.freetls.fastly.net', 'last.fm',
        'static.qobuz.com', 'mzstatic.com', 'is1-ssl.mzstatic.com',
        'i.scdn.co', 'e.snmc.io',
        'f4.bcbits.com', 'bcbits.com',
        'cdn-images.dzcdn.net',
        'm.media-amazon.com',
        'resources.tidal.com',
        'i.scdn.co', 'spotifycdn.com',
        'geo-media.beatport.com',
    ];
    // Domains whose CDNs commonly reject a plain server-side fetch-by-URL (bot/hotlink
    // protection) but serve the same image fine to a real browser request. Shared by the
    // manual picker flow and batch mode so both take the same upload path for these hosts.
    const NEEDS_CLIENT_FETCH_RE = /apple\.com|mzstatic\.com|spotify\.com|scdn\.co|spotifycdn\.com|deezer\.com|dzcdn\.net|tidal\.com|resources\.tidal\.com|bandcamp\.com|bcbits\.com|amazon\.|m\.media-amazon\.com|qobuz\.com|i\.discogs\.com|coverartarchive\.org|musicbrainz\.org|beatport\.com/i;

    function isOnRehostDomain(url) {
        try {
            const hostname = new URL(url).hostname.toLowerCase();
            return REHOST_DOMAINS.some(d => hostname === d || hostname.endsWith('.' + d));
        } catch { return false; }
    }

    function friendlyHostName(url) {
        try {
            const h = new URL(url).hostname.replace(/^www\./, '');
            if (h.includes('redacted.sh') || h.includes('images.redacted.sh')) return 'RED';
            if (h.includes('ptpimg.me'))   return 'ptpimg';
            if (h.includes('imgbb.com') || h.includes('ibb.co')) return 'imgbb';
            if (h.includes('catbox.moe'))  return 'catbox';
            if (h.includes('thesungod') || h.includes('ra.thesungod')) return 'TheSunGod';
            return h;
        } catch(e) { return 'unknown host'; }
    }
    function isOnSourceDomain(url) {
        try {
            const hostname = new URL(url).hostname.toLowerCase();
            return SOURCE_DOMAINS.some(d => hostname === d || hostname.endsWith('.' + d));
        } catch { return false; }
    }

    // RED serves two URL forms for its own hosted images: "/t/" (a lower-resolution
    // thumbnail) and "/i/" (the full-size original). A torrent group's stored cover can
    // end up pointing at the /t/ form — valid and on RED, but not the best available
    // version. Detect that case so it can be upgraded to /i/ for free (a URL string
    // swap, no re-upload) instead of being treated as "already fine, nothing to do".
    function isRedThumbnailUrl(url) {
        if (!url) return false;
        return /^https?:\/\/(?:www\.)?redacted\.sh\/t\/[a-zA-Z0-9_-]+\.[a-zA-Z0-9]+$/i.test(url.trim());
    }
    function upgradeRedThumbnailUrl(url) {
        return url.replace(/(redacted\.sh)\/t\//i, '$1/i/');
    }

    const IMGBB_DEFAULT_KEY  = '';

    function getImgbbKey()   { return GM_getValue('imgbbAPIKey',    IMGBB_DEFAULT_KEY); }
    function getCatboxHash() { return GM_getValue('catboxUserHash', ''); }
    function setImgbbKey(key) { GM_setValue('imgbbAPIKey',    key); }
    function setCatboxHash(h) { GM_setValue('catboxUserHash', h); }

    function getSungodKey()      { return GM_getValue('sungodAPIKey', ''); }
    function setSungodKey(key)   { GM_setValue('sungodAPIKey', key); }

    function getCustomUploadUrl()    { return GM_getValue('customUploadUrl',    ''); }
    function getCustomFileField()    { return GM_getValue('customFileField',    'file'); }
    function getCustomResponsePath() { return GM_getValue('customResponsePath', 'plaintext'); }
    function setCustomUploadUrl(v)    { GM_setValue('customUploadUrl',    v); }
    function setCustomFileField(v)    { GM_setValue('customFileField',    v); }
    function setCustomResponsePath(v) { GM_setValue('customResponsePath', v); }

    function getRedApiKey()    { return GM_getValue('redApiKey', ''); }

    // Permanent lifetime counter — increments on every successful rehost and is never
    // cleared by "Reset progress" (that only clears the resumable dedup caches below).
    function getLifetimeRehostedCount() { return parseInt(GM_getValue('coverup_lifetime_rehosted', '0'), 10) || 0; }
    function incrementLifetimeRehostedCount() { GM_setValue('coverup_lifetime_rehosted', String(getLifetimeRehostedCount() + 1)); }

    function getProcessedGroups()  { try { return new Set(JSON.parse(GM_getValue('coverup_processed_groups', '[]'))); } catch(e) { return new Set(); } }
    function addProcessedGroup(gid) {
        incrementLifetimeRehostedCount();
        const set = getProcessedGroups();
        set.add(String(gid));
        GM_setValue('coverup_processed_groups', JSON.stringify([...set]));
    }
    function clearProcessedGroups() { GM_setValue('coverup_processed_groups', '[]'); }

    // Separate from "processed" (successfully rehosted) — "scanned" tracks groups that
    // were checked and found to need no action, so resumed/repeated batch runs don't
    // keep re-fetching the same already-clean groups. Groups queued FOR rehosting are
    // never added here until actually rehosted, so an interrupted run rediscovers them.
    const SCANNED_GROUPS_CAP = 20000;
    function getScannedGroups() { try { return new Set(JSON.parse(GM_getValue('coverup_scanned_groups', '[]'))); } catch(e) { return new Set(); } }
    function addScannedGroups(gids) {
        if (!gids || gids.length === 0) return;
        const set = getScannedGroups();
        gids.forEach(g => set.add(String(g)));
        let arr = [...set];
        if (arr.length > SCANNED_GROUPS_CAP) arr = arr.slice(arr.length - SCANNED_GROUPS_CAP);
        GM_setValue('coverup_scanned_groups', JSON.stringify(arr));
    }
    function clearScannedGroups() { GM_setValue('coverup_scanned_groups', '[]'); }

    // Same idea as getScannedGroups()/addScannedGroups() above, but for the collage
    // description-image batch (both the per-user panel and the general browse-page
    // panel) — a collage only gets marked once its description has actually been
    // checked, so a later batch run skips it instead of re-fetching + re-scanning the
    // same description again. Collages that errored out (form/auth fetch failed) are
    // deliberately NOT marked, so they're retried next run.
    const SCANNED_COLLAGE_DESC_CAP = 20000;
    function getScannedCollageDescriptions() { try { return new Set(JSON.parse(GM_getValue('coverup_scanned_collage_desc', '[]'))); } catch(e) { return new Set(); } }
    function addScannedCollageDescriptions(ids) {
        if (!ids || ids.length === 0) return;
        const set = getScannedCollageDescriptions();
        ids.forEach(id => set.add(String(id)));
        let arr = [...set];
        if (arr.length > SCANNED_COLLAGE_DESC_CAP) arr = arr.slice(arr.length - SCANNED_COLLAGE_DESC_CAP);
        GM_setValue('coverup_scanned_collage_desc', JSON.stringify(arr));
    }
    function clearScannedCollageDescriptions() { GM_setValue('coverup_scanned_collage_desc', '[]'); }

    // Fast Mode only ever does a shallow check (ptpimg cache only), so a group it gives
    // up on isn't a real "nothing to do here" verdict — it must stay eligible for a full
    // Deep Mode pass. But that meant Fast Mode itself never remembered anything between
    // runs, forcing every repeat Fast Mode scan to re-examine the whole list from
    // scratch. This second, separate set gives Fast Mode its own memory: entries here
    // are skipped by future Fast Mode runs only — Deep Mode always ignores this set and
    // checks everything not in the (mode-independent) scanned/processed sets above.
    const FAST_SCANNED_GROUPS_CAP = 20000;
    function getFastScannedGroups() { try { return new Set(JSON.parse(GM_getValue('coverup_fast_scanned_groups', '[]'))); } catch(e) { return new Set(); } }
    function addFastScannedGroups(gids) {
        if (!gids || gids.length === 0) return;
        const set = getFastScannedGroups();
        gids.forEach(g => set.add(String(g)));
        let arr = [...set];
        if (arr.length > FAST_SCANNED_GROUPS_CAP) arr = arr.slice(arr.length - FAST_SCANNED_GROUPS_CAP);
        GM_setValue('coverup_fast_scanned_groups', JSON.stringify(arr));
    }
    function clearFastScannedGroups() { GM_setValue('coverup_fast_scanned_groups', '[]'); }

    // Scoped alternative to the full clearProcessedGroups()/clearScannedGroups() reset —
    // removes only the given group IDs from all tracking sets, leaving every other
    // page's already-verified progress untouched. Needed because a group can get
    // incorrectly marked "scanned" by an older buggy run (or a since-fixed edge case)
    // without the rest of the account's tracking being wrong — a full reset would be
    // overkill and would force every other page to be re-checked from scratch.
    function removeGroupsFromProgress(groupIds) {
        if (!groupIds || groupIds.length === 0) return 0;
        const processed   = getProcessedGroups();
        const scanned      = getScannedGroups();
        const fastScanned  = getFastScannedGroups();
        let affected = 0;
        groupIds.forEach(gid => {
            const key = String(gid);
            const wasTracked = processed.has(key) || scanned.has(key) || fastScanned.has(key);
            processed.delete(key);
            scanned.delete(key);
            fastScanned.delete(key);
            if (wasTracked) affected++;
        });
        GM_setValue('coverup_processed_groups', JSON.stringify([...processed]));
        GM_setValue('coverup_scanned_groups', JSON.stringify([...scanned]));
        GM_setValue('coverup_fast_scanned_groups', JSON.stringify([...fastScanned]));
        return affected;
    }

    // Remembers where the "missing artwork" scan left off in better.php's pagination,
    // so the panel can default "Start page" to pick up where you stopped last time
    // instead of you having to track it yourself across thousands of pages.
    function getLastBetterPage() { return parseInt(GM_getValue('coverup_last_better_page', '1'), 10) || 1; }
    function setLastBetterPage(n) { GM_setValue('coverup_last_better_page', String(n)); }

    // Same "remember where I left off" idea for the general/unscoped collages.php
    // browse-page batch — avoids re-typing (or accidentally re-picking) the same page
    // range on every run.
    function getLastGeneralCollagePage() { return parseInt(GM_getValue('coverup_last_general_collage_page', '1'), 10) || 1; }
    function setLastGeneralCollagePage(n) { GM_setValue('coverup_last_general_collage_page', String(n)); }

    // Same idea, but for the separate "missing artist image" list (better.php?method=cover) —
    // its own pagination pointer since it's a different, much larger list (millions of
    // artists vs. thousands of releases) that gets scanned independently.
    function getLastBetterCoverPage() { return parseInt(GM_getValue('coverup_last_better_cover_page', '1'), 10) || 1; }
    function setLastBetterCoverPage(n) { GM_setValue('coverup_last_better_cover_page', String(n)); }

    // Tracks which artist IDs have already been checked for a missing image, separately
    // from the release-level processed/scanned sets above (different ID namespace —
    // artist IDs vs. group IDs — so these must never be mixed together).
    function getProcessedArtists() { try { return new Set(JSON.parse(GM_getValue('coverup_processed_artists', '[]'))); } catch(e) { return new Set(); } }
    function addProcessedArtists(ids) {
        if (!ids || ids.length === 0) return;
        const set = getProcessedArtists();
        ids.forEach(id => set.add(String(id)));
        GM_setValue('coverup_processed_artists', JSON.stringify([...set]));
    }
    function clearProcessedArtists() { GM_setValue('coverup_processed_artists', '[]'); }

    // Separate lifetime counter for artist images specifically, same pattern as
    // coverup_lifetime_rehosted above but for this different kind of asset — increments
    // once per successfully saved artist image, never cleared by "Reset progress".
    function getLifetimeArtistImagesAddedCount() { return parseInt(GM_getValue('coverup_lifetime_artist_images', '0'), 10) || 0; }
    function incrementLifetimeArtistImagesAddedCount() { GM_setValue('coverup_lifetime_artist_images', String(getLifetimeArtistImagesAddedCount() + 1)); }

    // Distinct from "checked" (coverup_processed_artists, above) — this only tracks
    // artists that actually got an image successfully saved, so the panel can show
    // "checked" vs. "added" separately, same distinction as processed/scanned for groups.
    function getAddedArtistImages() { try { return new Set(JSON.parse(GM_getValue('coverup_added_artist_images', '[]'))); } catch(e) { return new Set(); } }
    function addAddedArtistImage(artistId) {
        incrementLifetimeArtistImagesAddedCount();
        const set = getAddedArtistImages();
        set.add(String(artistId));
        GM_setValue('coverup_added_artist_images', JSON.stringify([...set]));
    }
    function clearAddedArtistImages() { GM_setValue('coverup_added_artist_images', '[]'); }

    function refreshProcessedCountDisplay() {
        const el = document.getElementById('batch-processed-count');
        if (!el) return;
        const nProcessed    = getProcessedGroups().size;
        const nScanned      = getScannedGroups().size;
        const nFastScanned  = getFastScannedGroups().size;
        const lifetime      = getLifetimeRehostedCount();
        if (nScanned === 0 && nProcessed === 0 && nFastScanned === 0) {
            el.textContent = `${lifetime} rehosted all-time. No groups checked yet this session.`;
        } else {
            el.textContent = `${lifetime} rehosted all-time — ${nScanned + nFastScanned} groups checked, ${nProcessed} rehosted since last reset — progress is saved automatically, safe to come back later`;
        }
    }

    // Single shared fixed-position box in the bottom-right corner that holds every
    // small CoverUp control (batch-panel show pill, settings gear, hide/reveal dot)
    // as stacked rows inside ONE bordered container, instead of several separate
    // floating boxes stacked on top of each other.
    function getCoverupCornerCluster() {
        let cluster = document.getElementById('coverup-corner-cluster');
        if (!cluster) {
            cluster = document.createElement('div');
            cluster.id = 'coverup-corner-cluster';
            cluster.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:99997;display:flex;flex-direction:column;align-items:stretch;gap:6px;background:#1a1a1a;border:1px solid #4CAF50;border-radius:6px;padding:8px 10px;box-shadow:0 2px 8px rgba(0,0,0,0.5);font-family:sans-serif;';
            document.body.appendChild(cluster);
        }
        return cluster;
    }

    // Small collapse/expand toggle shared by all 4 batch panels (uploads/seeding/
    // snatched, single collage, all collages, artist). State is remembered globally
    // so it stays collapsed (or open) as you move between the different batch pages.
    const BATCH_PANEL_COLLAPSED_KEY = 'coverup_batch_panel_collapsed';
    function setupBatchPanelCollapse(panel) {
        const toggle = panel.querySelector('#batch-panel-toggle');
        if (!toggle) return;
        toggle.textContent = 'Hide';

        // Collapsing hides the ENTIRE panel (not just its body) and shows a row inside
        // the shared corner cluster — clicking it brings the panel back.
        const cluster = getCoverupCornerCluster();
        const pill = document.createElement('div');
        pill.id = 'coverup-batch-panel-pill';
        pill.textContent = '▸ Show batch panel';
        pill.style.cssText = 'display:none;order:0;cursor:pointer;color:#4CAF50;font-size:11px;font-weight:bold;white-space:nowrap;';
        cluster.appendChild(pill);

        function collapse() {
            panel.style.display = 'none';
            pill.style.display = 'block';
            GM_setValue(BATCH_PANEL_COLLAPSED_KEY, true);
        }
        function expand() {
            panel.style.display = '';
            pill.style.display = 'none';
            GM_setValue(BATCH_PANEL_COLLAPSED_KEY, false);
        }

        toggle.onclick = collapse;
        pill.onclick = expand;

        if (GM_getValue(BATCH_PANEL_COLLAPSED_KEY, false)) {
            collapse();
        }
    }

    // Hover-to-preview for the approval-thumbnail picker used by every batch panel's
    // "needs approval" candidates. The thumbs render at 100x100, too small to judge a
    // cover confidently — previously the only way to see it larger was opening it in a
    // new tab. One delegated listener covers every picker (they all share the
    // .approval-thumb class), showing a bigger version next to the cursor on hover —
    // no extra network request, it just reuses the image already loaded in the thumb.
    (function setupApprovalThumbHoverPreview() {
        const PREVIEW_SIZE = 560;
        const preview = document.createElement('img');
        preview.id = 'coverup-thumb-hover-preview';
        preview.style.cssText = `display:none;position:fixed;z-index:100005;width:${PREVIEW_SIZE}px;height:${PREVIEW_SIZE}px;object-fit:contain;background:#111;border:2px solid #4CAF50;border-radius:6px;box-shadow:0 4px 20px rgba(0,0,0,0.8);pointer-events:none;`;
        document.body.appendChild(preview);

        function positionPreview(e) {
            const margin = 20;
            let left = e.clientX + margin;
            let top  = e.clientY + margin;
            if (left + PREVIEW_SIZE + margin > window.innerWidth)  left = e.clientX - PREVIEW_SIZE - margin;
            if (top + PREVIEW_SIZE + margin > window.innerHeight)  top  = window.innerHeight - PREVIEW_SIZE - margin;
            if (left < 0) left = margin;
            if (top < 0)  top  = margin;
            preview.style.left = `${left}px`;
            preview.style.top  = `${top}px`;
        }

        document.addEventListener('mouseover', (e) => {
            const thumb = e.target.closest && e.target.closest('.approval-thumb');
            if (!thumb) return;
            preview.src = thumb.src;
            preview.style.display = 'block';
            positionPreview(e);
        });
        document.addEventListener('mousemove', (e) => {
            if (preview.style.display !== 'block') return;
            if (!(e.target.closest && e.target.closest('.approval-thumb'))) return;
            positionPreview(e);
        });
        document.addEventListener('mouseout', (e) => {
            const thumb = e.target.closest && e.target.closest('.approval-thumb');
            if (!thumb) return;
            preview.style.display = 'none';
        });
    })();

    function setRedApiKey(v)   { GM_setValue('redApiKey', v); }

    function getPreferredFallbackHost() { return GM_getValue('preferredFallbackHost', ''); }
    function setPreferredFallbackHost(host) { GM_setValue('preferredFallbackHost', host); }

    // Persist rehosted URL mappings across page loads (survives redirects)
    function getRehostedUrl(originalUrl) { return GM_getValue('rehosted_' + originalUrl, ''); }
    function setRehostedUrl(originalUrl, newUrl) { GM_setValue('rehosted_' + originalUrl, newUrl); }

    function chooseFallbackHost(callback) {
        const current = getPreferredFallbackHost();
        if (current === 'imgbb' || current === 'catbox' || current === 'sungod') {
            callback(current); return;
        }
        if (current === 'custom' && getCustomUploadUrl()) {
            callback('custom'); return;
        }

        // No remembered fallback — show a minimal picker for fallback hosts only.
        // (RED is handled upstream before this is ever called.)
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.92);z-index:100000;display:flex;align-items:center;justify-content:center;';
        overlay.innerHTML = `
            <div style="background:#1a1a1a;padding:28px;border-radius:12px;border:2px solid #444;max-width:500px;width:92%;color:#fff;font-family:sans-serif;">
                <h2 style="margin-top:0;color:#4CAF50;">Choose fallback image host</h2>
                <p style="color:#ccc;font-size:13px;line-height:1.6;margin-bottom:16px;">RED image host is unavailable or not configured. Choose a fallback:</p>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px;">
                    <button id="choose-imgbb" style="padding:14px;background:#222;border:2px solid #555;border-radius:8px;color:#fff;cursor:pointer;text-align:left;">
                        <div style="font-weight:bold;margin-bottom:3px;">imgbb</div>
                        <div style="font-size:11px;color:#aaa;">Requires free API key</div>
                    </button>
                    <button id="choose-catbox" style="padding:14px;background:#222;border:2px solid #555;border-radius:8px;color:#fff;cursor:pointer;text-align:left;">
                        <div style="font-weight:bold;margin-bottom:3px;">catbox</div>
                        <div style="font-size:11px;color:#aaa;">No key required</div>
                    </button>
                </div>
                <div style="background:#222;border:1px solid #555;border-radius:8px;padding:14px;margin-bottom:12px;">
                    <div style="font-weight:bold;font-size:13px;margin-bottom:8px;">TheSunGod ☀️</div>
                    <input id="sungod-api-key" type="text" placeholder="TheSunGod API key..."
                        value="${getSungodKey()}"
                        style="width:100%;padding:8px 10px;background:#111;border:1px solid #555;color:#fff;border-radius:5px;font-size:12px;box-sizing:border-box;margin-bottom:8px;">
                    <button id="choose-sungod" style="width:100%;padding:9px;background:#f59e0b;color:#fff;border:none;border-radius:5px;cursor:pointer;font-weight:bold;">Use TheSunGod</button>
                </div>
                <div style="background:#222;border:1px solid #555;border-radius:8px;padding:14px;margin-bottom:16px;">
                    <div style="font-weight:bold;font-size:13px;margin-bottom:8px;">Custom host</div>
                    <input id="custom-host-url" type="text" placeholder="https://example.com/upload"
                        value="${getCustomUploadUrl()}"
                        style="width:100%;padding:8px 10px;background:#111;border:1px solid #555;color:#fff;border-radius:5px;font-size:12px;box-sizing:border-box;margin-bottom:6px;">
                    <div id="custom-advanced-toggle" style="font-size:11px;color:#4CAF50;cursor:pointer;margin-bottom:0;">▶ Advanced options</div>
                    <div id="custom-advanced" style="display:none;margin-top:8px;">
                        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
                            <div>
                                <label style="font-size:11px;color:#aaa;display:block;margin-bottom:3px;">File field name</label>
                                <input id="custom-file-field" type="text" placeholder="file" value="${getCustomFileField()}"
                                    style="width:100%;padding:6px 8px;background:#111;border:1px solid #555;color:#fff;border-radius:4px;font-size:11px;box-sizing:border-box;">
                            </div>
                            <div>
                                <label style="font-size:11px;color:#aaa;display:block;margin-bottom:3px;">Response URL path</label>
                                <input id="custom-response-path" type="text" placeholder="plaintext or data.url" value="${getCustomResponsePath()}"
                                    style="width:100%;padding:6px 8px;background:#111;border:1px solid #555;color:#fff;border-radius:4px;font-size:11px;box-sizing:border-box;">
                            </div>
                        </div>
                    </div>
                    <button id="choose-custom" style="margin-top:10px;width:100%;padding:9px;background:#2196F3;color:#fff;border:none;border-radius:5px;cursor:pointer;font-weight:bold;">Use Custom Host</button>
                </div>
                <div style="display:flex;justify-content:space-between;align-items:center;">
                    <label style="font-size:12px;color:#aaa;display:flex;align-items:center;gap:6px;cursor:pointer;">
                        <input id="remember-fallback-choice" type="checkbox"> Remember my choice
                    </label>
                    <button id="cancel-fallback-choice" style="padding:9px 14px;background:#555;color:#fff;border:none;border-radius:5px;cursor:pointer;">Cancel</button>
                </div>
            </div>`;
        document.body.appendChild(overlay);

        overlay.querySelector('#remember-fallback-choice').checked = false;
        overlay.querySelector('#custom-advanced-toggle').onclick = function() {
            const adv = overlay.querySelector('#custom-advanced');
            const open = adv.style.display !== 'none';
            adv.style.display = open ? 'none' : 'block';
            this.textContent = (open ? '▶' : '▼') + ' Advanced options';
        };

        function finish(host) {
            const remember = overlay.querySelector('#remember-fallback-choice').checked;
            if (remember) setPreferredFallbackHost(host);
            document.body.removeChild(overlay);
            callback(host);
        }

        overlay.querySelector('#choose-imgbb').onclick  = () => finish('imgbb');
        overlay.querySelector('#choose-catbox').onclick = () => finish('catbox');
        overlay.querySelector('#choose-sungod').onclick = () => {
            const key = overlay.querySelector('#sungod-api-key').value.trim();
            if (!key) { alert('Please enter your TheSunGod API key.'); return; }
            setSungodKey(key);
            finish('sungod');
        };
        overlay.querySelector('#choose-custom').onclick = () => {
            const url = overlay.querySelector('#custom-host-url').value.trim();
            if (!url) { alert('Please enter the upload URL.'); return; }
            setCustomUploadUrl(url);
            setCustomFileField(overlay.querySelector('#custom-file-field').value.trim());
            setCustomResponsePath(overlay.querySelector('#custom-response-path').value.trim());
            finish('custom');
        };
        overlay.querySelector('#cancel-fallback-choice').onclick = () => {
            document.body.removeChild(overlay);
            callback(null);
        };
    }


    // RED's published API rate limit is 5 req/10s for cookie auth, 10 req/10s for
    // API-key auth — enforced per-user, not per-IP. This rolling-window throttle keeps
    // every RED API call (image uploads, ajax.php GETs/POSTs) under that ceiling instead
    // of relying solely on reacting to 429s after the fact.
    const RED_API_RATE_LIMIT  = 10;
    const RED_API_RATE_WINDOW = 10500;
    const _redApiCallTimes = [];
    function redApiThrottle() {
        return new Promise(resolve => {
            (function attempt() {
                const now = Date.now();
                while (_redApiCallTimes.length && now - _redApiCallTimes[0] >= RED_API_RATE_WINDOW) {
                    _redApiCallTimes.shift();
                }
                if (_redApiCallTimes.length < RED_API_RATE_LIMIT) {
                    _redApiCallTimes.push(now);
                    resolve();
                } else {
                    const waitMs = RED_API_RATE_WINDOW - (now - _redApiCallTimes[0]) + 20;
                    setTimeout(attempt, waitMs);
                }
            })();
        });
    }

    function uploadToRedImageHost(blobOrUrl, callback) {
        const apiKey = getRedApiKey();
        if (!apiKey) { callback(null); return; }

        const fd = new FormData();
        if (typeof blobOrUrl === 'string') {
            // URL-based rehost — pass url param
            fd.append('url', blobOrUrl);
        } else {
            fd.append('file', blobOrUrl, 'cover.jpg');
        }

        redApiThrottle().then(() => GM_xmlhttpRequest({
            method: 'POST',
            url: 'https://redacted.sh/ajax.php?action=upload_image',
            headers: { 'Authorization': apiKey },
            data: fd,
            timeout: 20000,
            onload: function(r) {
                try {
                    const data = JSON.parse(r.responseText);
                    if (data.status === 'success' && data.response) {
                        const url = data.response.url || data.response;
                        if (url && typeof url === 'string') { callback(url); return; }
                    }
                    console.warn('[CoverUp] RED image host upload failed:', r.responseText.slice(0, 300));
                    callback(null);
                } catch(e) {
                    console.warn('[CoverUp] RED image host parse error:', e, r.responseText.slice(0, 200));
                    callback(null);
                }
            },
            onerror:   function(e) { console.warn('[CoverUp] RED upload onerror:', e); callback(null); },
            ontimeout: function()  { console.warn('[CoverUp] RED upload timeout'); callback(null); }
        }));
    }

    function uploadToImgbb(blob, callback) {
        const key = getImgbbKey();
        if (!key) {
            const entered = prompt('Enter your imgbb API key (get one at https://api.imgbb.com):');
            if (!entered) { callback(null); return; }
            setImgbbKey(entered.trim());
        }
        const reader = new FileReader();
        reader.onload = function() {
            const base64 = reader.result.split(',')[1];
            GM_xmlhttpRequest({
                method: 'POST',
                url: 'https://api.imgbb.com/1/upload',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                data: `key=${getImgbbKey()}&image=${encodeURIComponent(base64)}`,
                onload: function(r) {
                    try {
                        const res = JSON.parse(r.responseText);
                        if (res.success) callback(res.data.url);
                        else { console.error('imgbb error:', res); callback(null); }
                    } catch(e) { console.error('imgbb parse error:', e); callback(null); }
                },
                onerror: function() { callback(null); }
            });
        };
        reader.readAsDataURL(blob);
    }

    // ============================================================
    // --- CATBOX UPLOAD ---
    // ============================================================

    function uploadToCatbox(blob, callback) {
        const fd = new FormData();
        fd.append('reqtype', 'fileupload');
        const hash = getCatboxHash();
        if (hash) fd.append('userhash', hash);
        fd.append('fileToUpload', blob, 'cover.jpg');
        GM_xmlhttpRequest({
            method: 'POST',
            url: 'https://catbox.moe/user/api.php',
            data: fd,
            timeout: 30000,
            onload: function(r) {
                const url = r.responseText && r.responseText.trim();
                if (url && url.startsWith('https://')) callback(url);
                else { console.error('Catbox error:', r.responseText); callback(null); }
            },
            onerror:   function() { callback(null); },
            ontimeout: function() { callback(null); }
        });
    }

    // ============================================================
    // --- SUNGOD UPLOAD ---
    // ============================================================

    function uploadToSungod(blobOrUrl, callback) {
        let key = getSungodKey();
        if (!key) {
            const entered = prompt('Enter your TheSunGod API key (get one at https://thesungod.xyz/settings/api):');
            if (!entered) { callback(null); return; }
            setSungodKey(entered.trim());
            key = entered.trim();
        }

        // If we have a raw URL (string), use the faster rehost_new endpoint
        if (typeof blobOrUrl === 'string') {
            const fd = new FormData();
            fd.append('api_key', key);
            fd.append('link', blobOrUrl);
            GM_xmlhttpRequest({
                method: 'POST',
                url: 'https://thesungod.xyz/api/image/rehost_new',
                data: fd,
                timeout: 30000,
                onload: function(r) {
                    try {
                        const res = JSON.parse(r.responseText);
                        if (res.link && /^https?:\/\//i.test(res.link)) { callback(res.link); return; }
                        console.error('[SunGod] rehost_new unexpected response:', r.responseText);
                        callback(null);
                    } catch(e) { console.error('[SunGod] rehost_new parse error:', e); callback(null); }
                },
                onerror:   function() { callback(null); },
                ontimeout: function() { callback(null); }
            });
            return;
        }

        // Blob upload via /api/image/upload
        const fd = new FormData();
        fd.append('api_key', key);
        fd.append('image', blobOrUrl, 'cover.jpg');
        GM_xmlhttpRequest({
            method: 'POST',
            url: 'https://thesungod.xyz/api/image/upload',
            data: fd,
            timeout: 30000,
            onload: function(r) {
                try {
                    const res = JSON.parse(r.responseText);
                    if (res.links && res.links.length > 0) { callback(res.links[0]); return; }
                    console.error('[SunGod] upload unexpected response:', r.responseText);
                    callback(null);
                } catch(e) { console.error('[SunGod] upload parse error:', e); callback(null); }
            },
            onerror:   function() { callback(null); },
            ontimeout: function() { callback(null); }
        });
    }

    // ============================================================
    // --- CUSTOM HOST UPLOAD ---
    // ============================================================

    function uploadToCustomHost(blob, callback) {
        const uploadUrl = getCustomUploadUrl();
        if (!uploadUrl) { callback(null); return; }

        const fileField = getCustomFileField() || 'file';
        const fd = new FormData();
        fd.append(fileField, blob, 'cover.jpg');

        GM_xmlhttpRequest({
            method: 'POST',
            url: uploadUrl,
            data: fd,
            timeout: 30000,
            onload: function(r) {
                try {
                    const body = r.responseText && r.responseText.trim();
                    if (!body) { console.error('Custom host: empty response'); callback(null); return; }

                    // Strategy 1: plain text response that looks like a URL
                    if (/^https?:\/\//i.test(body)) {
                        callback(body);
                        return;
                    }

                    // Strategy 2: stored response path (e.g. 'data.url')
                    const storedPath = getCustomResponsePath();
                    if (storedPath && storedPath !== 'plaintext') {
                        try {
                            const json = JSON.parse(body);
                            const val  = storedPath.split('.').reduce((o, k) => o && o[k], json);
                            if (val && /^https?:\/\//i.test(val)) { callback(val); return; }
                        } catch(e) {}
                    }

                    // Strategy 3: try common JSON paths automatically
                    try {
                        const json  = JSON.parse(body);
                        const paths = ['url','data.url','image.url','files.0.url','file.url','link','data.link','location'];
                        for (const path of paths) {
                            const val = path.split('.').reduce((o, k) => {
                                if (o === null || o === undefined) return undefined;
                                // handle numeric indices
                                return isNaN(k) ? o[k] : o[parseInt(k)];
                            }, json);
                            if (val && /^https?:\/\//i.test(val)) {
                                // Save this path for next time
                                setCustomResponsePath(path);
                                callback(val);
                                return;
                            }
                        }
                        console.error('Custom host: could not find URL in JSON response:', body);
                        callback(null);
                    } catch(e) {
                        console.error('Custom host: unparseable response:', body);
                        callback(null);
                    }
                } catch(e) {
                    console.error('Custom host error:', e);
                    callback(null);
                }
            },
            onerror:   function() { callback(null); },
            ontimeout: function() { callback(null); }
        });
    }

    // ============================================================

    // --- UNIFIED UPLOAD WITH FALLBACK: RED → ptpimg → imgbb → catbox ---
    // ============================================================

    function uploadWithFallback(blob, oldUrl, link, callback) {
        function uploadToPreferredHost() {
            chooseFallbackHost(function(host) {
                if (!host) {
                    link.textContent = 'Upload cancelled';
                    link.style.color = 'red';
                    return;
                }
                if (host === 'imgbb') {
                    link.textContent = 'Uploading to imgbb...';
                    link.style.color = 'orange';
                    tryImgbb(blob, link, callback);
                } else if (host === 'catbox') {
                    link.textContent = 'Uploading to catbox...';
                    link.style.color = 'orange';
                    tryCatbox(blob, link, callback);
                } else if (host === 'sungod') {
                    link.textContent = 'Uploading to TheSunGod...';
                    link.style.color = 'orange';
                    trySungod(blob, oldUrl, link, callback);
                } else if (host === 'custom') {
                    const hostLabel = getCustomUploadUrl()
                        ? new URL(getCustomUploadUrl()).hostname
                        : 'custom host';
                    link.textContent = `Uploading to ${hostLabel}...`;
                    link.style.color = 'orange';
                    uploadToCustomHost(blob, function(url) {
                        if (url) callback(url);
                        else {
                            link.textContent = 'Custom host failed — trying catbox...';
                            link.style.color = 'orange';
                            tryCatbox(blob, link, callback);
                        }
                    });
                }
            });
        }

        const redApiKey = getRedApiKey();
        if (redApiKey) {
            // RED image host is the default — try it first
            link.textContent = 'Uploading to RED image host...';
            link.style.color = 'orange';
            uploadToRedImageHost(blob, function(url) {
                if (url) { callback(url); return; }
                console.warn('[CoverUp] RED image host failed, using preferred fallback host');
                uploadToPreferredHost();
            });
        } else {
            uploadToPreferredHost();
        }
    }

    function tryImgbb(blob, link, callback) {
        link.textContent = 'Uploading to imgbb...';
        link.style.color = 'orange';
        uploadToImgbb(blob, function(url) {
            if (url) callback(url);
            else {
                console.warn('imgbb failed, trying catbox');
                tryCatbox(blob, link, callback);
            }
        });
    }

    function tryCatbox(blob, link, callback) {
        link.textContent = 'Uploading to catbox...';
        link.style.color = 'orange';
        uploadToCatbox(blob, function(url) {
            if (url) callback(url);
            else { link.textContent = 'Upload failed (all services down)'; link.style.color = 'red'; }
        });
    }

    function trySungod(blob, oldUrl, link, callback) {
        link.textContent = 'Uploading to TheSunGod...';
        link.style.color = 'orange';
        // Prefer rehost_new if we have the original URL (faster, no re-encode)
        // but not if it's the noartwork placeholder
        const isPlaceholder = oldUrl && typeof oldUrl === 'string' && oldUrl.includes('noartwork');
        const target = (!isPlaceholder && oldUrl && typeof oldUrl === 'string' && /^https?:\/\//i.test(oldUrl))
            ? oldUrl : blob;
        uploadToSungod(target, function(url) {
            if (url) callback(url);
            else {
                // If rehost failed and we used a URL, retry with blob
                if (typeof target === 'string' && blob instanceof Blob) {
                    uploadToSungod(blob, function(url2) {
                        if (url2) callback(url2);
                        else {
                            link.textContent = 'TheSunGod failed — trying catbox...';
                            link.style.color = 'orange';
                            tryCatbox(blob, link, callback);
                        }
                    });
                } else {
                    link.textContent = 'TheSunGod failed — trying catbox...';
                    link.style.color = 'orange';
                    tryCatbox(blob, link, callback);
                }
            }
        });
    }

    // ============================================================
    // --- DISCOGS TOKEN MANAGEMENT ---
    // ============================================================

    function getDiscogsToken()      { return GM_getValue('discogsToken', ''); }
    function setDiscogsToken(token) { GM_setValue('discogsToken', token); }


    function showDiscogsSetup(callback) {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.92);z-index:100000;display:flex;align-items:center;justify-content:center;';
        overlay.innerHTML = `
            <div style="background:#1a1a1a;padding:35px;border-radius:12px;border:2px solid #444;max-width:550px;color:#fff;font-family:sans-serif;">
                <h2 style="margin-top:0;color:#4CAF50;">🎵 Discogs Setup Required</h2>
                <p style="color:#ccc;line-height:1.6;margin-bottom:20px;">To search Discogs for artwork, this script needs your API token.</p>
                <div style="background:#252525;padding:20px;border-radius:8px;border-left:4px solid #4CAF50;margin-bottom:20px;">
                    <h3 style="margin:0 0 10px 0;font-size:16px;color:#4CAF50;">How to get your token:</h3>
                    <ol style="margin:0;padding-left:20px;color:#aaa;line-height:1.8;">
                        <li>Click "Open Discogs" below to login</li>
                        <li>Go to Settings → Developers</li>
                        <li>Generate a new token</li>
                        <li>Copy and paste it below</li>
                    </ol>
                </div>
                <input type="text" id="discogs-token-input" placeholder="Paste your Discogs token here..."
                    style="width:100%;padding:12px;background:#222;border:1px solid #555;color:#fff;border-radius:6px;margin-bottom:20px;font-family:monospace;box-sizing:border-box;">
                <div style="display:flex;gap:10px;justify-content:flex-end;">
                    <button id="open-discogs-btn"     style="padding:12px 24px;background:#2196F3;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:bold;">Open Discogs</button>
                    <button id="save-token-btn"       style="padding:12px 24px;background:#4CAF50;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:bold;">Save Token</button>
                    <button id="cancel-discogs-setup" style="padding:12px 24px;background:#555;color:#fff;border:none;border-radius:6px;cursor:pointer;">Cancel</button>
                </div>
            </div>`;
        document.body.appendChild(overlay);
        const input = overlay.querySelector('#discogs-token-input');
        input.focus();
        overlay.querySelector('#open-discogs-btn').onclick     = () => window.open('https://www.discogs.com/settings/developers', '_blank');
        overlay.querySelector('#save-token-btn').onclick       = () => {
            const token = input.value.trim();
            if (token) { setDiscogsToken(token); document.body.removeChild(overlay); callback(true); }
            else alert('Please enter a valid token');
        };
        overlay.querySelector('#cancel-discogs-setup').onclick = () => { document.body.removeChild(overlay); callback(false); };
        input.addEventListener('keypress', e => { if (e.key === 'Enter') overlay.querySelector('#save-token-btn').click(); });
    }



    // ============================================================
    // ============================================================
    // ============================================================
    // --- BATCH REHOST PANEL (uploads page) ---
    // ============================================================

    const BATCH_GEO_RESTRICTED = ['imgur.com', 'i.imgur.com', 'pixhost.to', 'img.pixhost.to'];

    // Extract every embedded image URL from a BBCode string. RED accepts two different
    // [img] forms — the usual two-tag "[img]url[/img]" and a single-tag "[img=url]"
    // (confirmed live on a collage description using the latter, which the two-tag-only
    // regex was silently missing entirely).
    function extractBBCodeImgUrls(bbcode) {
        const matches = [];
        const reClosed = /\[img\]([^\[]+)\[\/img\]/gi;
        const reAttr   = /\[img=([^\]]+)\]/gi;
        let m;
        while ((m = reClosed.exec(bbcode)) !== null) matches.push(m[1].trim());
        while ((m = reAttr.exec(bbcode)) !== null) matches.push(m[1].trim());
        return matches;
    }

    // Should this description image URL be rehosted?
    // Skip Discogs (too many variables), ptpimg (gone), already on RED
    function needsDescriptionRehost(url) {
        if (!url) return false;
        try {
            const h = new URL(url).hostname.toLowerCase();
            if (h.includes('redacted.sh') || h.includes('images.redacted.sh')) return false;
            if (h.includes('ptpimg.me')) return false;
            if (h.includes('discogs.com')) return false;
            return SOURCE_DOMAINS.some(d => h === d || h.endsWith('.' + d))
                || REHOST_DOMAINS.filter(d => !d.includes('redacted.sh')).some(d => h === d || h.endsWith('.' + d))
                || BATCH_GEO_RESTRICTED.some(d => h === d || h.endsWith('.' + d));
        } catch(e) { return false; }
    }

    // Bandcamp's own CDN (bcbits.com) periodically 404s on cover art even while the
    // label's Bandcamp page is alive — there's no working URL left anywhere in the
    // description to fall back to, so these can't be auto-fixed the way imgur/pixhost
    // links can. Used to flag them for manual review instead of endlessly retrying an
    // upload that will never succeed.
    function isBandcampImageUrl(url) {
        if (!url) return false;
        try {
            const h = new URL(url).hostname.toLowerCase();
            return h === 'bcbits.com' || h.endsWith('.bcbits.com') || h === 'bandcamp.com' || h.endsWith('.bandcamp.com');
        } catch(e) { return false; }
    }

    function needsBatchRehost(url) {
        if (!url) return false;
        try {
            const h = new URL(url).hostname.toLowerCase();
            // Already on RED — skip
            if (h.includes('redacted.sh') || h.includes('images.redacted.sh')) return false;
            // ptpimg — can't fetch, skip
            if (h.includes('ptpimg.me')) return false;
            // Source domain, non-RED rehost domain, or geo-restricted
            return SOURCE_DOMAINS.some(d => h === d || h.endsWith('.' + d))
                || REHOST_DOMAINS.filter(d => !d.includes('redacted.sh')).some(d => h === d || h.endsWith('.' + d))
                || BATCH_GEO_RESTRICTED.some(d => h === d || h.endsWith('.' + d));
        } catch(e) { return false; }
    }

    // ============================================================
    // --- PASTE-LIST INPUT PARSING (paste-a-list-of-groups batch panel) ---
    // ============================================================
    // Pulls group IDs out of whatever a user pastes: raw torrents.php URLs, bare
    // numeric IDs (one per line or comma-separated), or a mix of both.
    function extractGroupIdsFromPastedText(text) {
        const ids = new Set();
        const urlRe = /torrents\.php\?id=(\d+)/g;
        let m;
        while ((m = urlRe.exec(text)) !== null) ids.add(m[1]);
        text.split(/[\n,]/).forEach(part => {
            const t = part.trim();
            if (/^\d{2,}$/.test(t)) ids.add(t);
        });
        return [...ids];
    }

    // Given a RED forum-thread URL, fetches the page and extracts every non-struck-
    // through torrents.php group ID from the relevant post. Forum quote/reply chains
    // mean the URL's own #postNNNN fragment doesn't always land on the post that
    // actually contains the list (confirmed live: a URL can point at a short reply
    // that merely quotes the real list further up/down the same page) — so if the
    // fragment's own post has no torrent links at all, this falls back to whichever
    // post on the page has the most, which in practice is reliably the intended one.
    function fetchGroupIdsFromForumUrl(url, statusCb) {
        return new Promise((resolve) => {
            const fragMatch = url.match(/#post(\d+)/);
            const preferredId = fragMatch ? fragMatch[1] : null;
            if (statusCb) statusCb('Fetching forum thread…');
            GM_xmlhttpRequest({
                method: 'GET',
                url,
                timeout: 20000,
                onload: function(r) {
                    try {
                        const doc = new DOMParser().parseFromString(r.responseText, 'text/html');
                        const posts = [...doc.querySelectorAll('table.forum_post')];
                        function countLinks(el) { return el.querySelectorAll('a[href*="torrents.php?id="]').length; }
                        let target = preferredId ? doc.getElementById('post' + preferredId) : null;
                        if (!target || countLinks(target) === 0) {
                            target = posts.sort((a, b) => countLinks(b) - countLinks(a))[0] || null;
                        }
                        if (!target) { resolve([]); return; }
                        function isStruck(el) {
                            let node = el;
                            while (node && node !== target) {
                                const tag = node.tagName ? node.tagName.toLowerCase() : '';
                                if (tag === 's' || tag === 'strike' || tag === 'del') return true;
                                node = node.parentElement;
                            }
                            return false;
                        }
                        const links = [...target.querySelectorAll('a[href*="torrents.php?id="]')];
                        const ids = [...new Set(links.filter(a => !isStruck(a)).map(a => {
                            const mm = a.getAttribute('href').match(/id=(\d+)/);
                            return mm ? mm[1] : null;
                        }).filter(Boolean))];
                        resolve(ids);
                    } catch(e) { console.warn('[CoverUp] fetchGroupIdsFromForumUrl parse error:', e); resolve([]); }
                },
                onerror:   () => resolve([]),
                ontimeout: () => resolve([]),
            });
        });
    }

    let batchStopRequested = false;

    const BATCH_PAGE_TYPE_LABELS = { uploaded: 'My Uploads', seeding: 'Seeding', snatched: 'Snatched', leeching: 'Leeching' };
    const BATCH_PAGE_TYPE_NOUNS  = { uploaded: 'uploaded torrents', seeding: 'seeding torrents', snatched: 'snatched torrents', leeching: 'leeching torrents' };

    // --- Unified Test/Deep/Fast run-mode selector, shared by every batch panel ---
    // A single radio group replaces the old separate "Test mode" checkbox and
    // "Mode" dropdown — each option reveals only the sub-controls/description
    // relevant to it, selected via radio so the three choices are mutually exclusive.
    function renderBatchRunModeSelector(defaultLimit = 5) {
        return `
            <div class="batch-run-mode-selector" style="margin-bottom:10px;font-size:12px;">
                <label style="display:flex;align-items:flex-start;gap:6px;margin-bottom:6px;cursor:pointer;">
                    <input type="radio" name="batch-run-mode" value="test" checked style="margin-top:3px;flex-shrink:0;">
                    <span style="flex:1;">
                        <strong style="color:#ccc;">Test Mode</strong> <span style="color:#666;">— try a small number first to check the results before running for real.</span>
                        <div class="batch-mode-options" data-mode="test" style="margin-top:5px;display:flex;align-items:center;gap:6px;">
                            Limit to <input type="number" id="batch-test-limit" value="${defaultLimit}" min="1" max="50" style="width:52px;padding:4px 6px;background:#111;border:1px solid #555;color:#fff;border-radius:4px;font-size:12px;"> covers
                        </div>
                    </span>
                </label>
                <label style="display:flex;align-items:flex-start;gap:6px;margin-bottom:6px;cursor:pointer;">
                    <input type="radio" name="batch-run-mode" value="deep" style="margin-top:3px;flex-shrink:0;">
                    <span style="flex:1;">
                        <strong style="color:#ccc;">Deep Mode</strong>
                        <div class="batch-mode-options" data-mode="deep" style="display:none;margin-top:3px;color:#666;font-size:11px;">Full source search (Discogs, streaming, retail, page links) for every broken cover across your whole list. Thorough, but slower.</div>
                    </span>
                </label>
                <label style="display:flex;align-items:flex-start;gap:6px;cursor:pointer;">
                    <input type="radio" name="batch-run-mode" value="fast" style="margin-top:3px;flex-shrink:0;">
                    <span style="flex:1;">
                        <strong style="color:#ccc;">Fast Mode</strong>
                        <div class="batch-mode-options" data-mode="fast" style="display:none;margin-top:3px;color:#666;font-size:11px;">Only checks RED's own cache for ptpimg links across your whole list — skips everything else. Much quicker, fewer covers found.</div>
                    </span>
                </label>
            </div>`;
    }

    function wireBatchRunModeSelector(panel) {
        panel.querySelectorAll('input[name="batch-run-mode"]').forEach(radio => {
            radio.addEventListener('change', () => {
                panel.querySelectorAll('.batch-mode-options').forEach(el => {
                    if (el.dataset.mode !== radio.value) { el.style.display = 'none'; return; }
                    el.style.display = el.dataset.mode === 'test' ? 'flex' : 'block';
                });
            });
        });
    }

    function getBatchRunMode(panel) {
        const checked   = panel.querySelector('input[name="batch-run-mode"]:checked');
        const mode      = checked ? checked.value : 'test';
        const testLimit = parseInt(panel.querySelector('#batch-test-limit')?.value) || 5;
        return {
            limit: mode === 'test' ? testLimit : Infinity,
            ptpimgOnlyMode: mode === 'fast',
        };
    }

    function setupBatchRehostPanel() {
        const typeMatch = window.location.search.match(/[?&]type=(uploaded|seeding|snatched|leeching)\b/);
        const pageType = typeMatch ? typeMatch[1] : null;
        if (!pageType) return;

        const apiKey = getRedApiKey();
        if (!apiKey) return;

        // Get userid from URL
        const userIdMatch = window.location.search.match(/[?&]userid=(\d+)/);
        const userId = userIdMatch ? userIdMatch[1] : null;
        if (!userId) return;

        const pageTypeLabel = BATCH_PAGE_TYPE_LABELS[pageType];
        const torrentsNoun  = BATCH_PAGE_TYPE_NOUNS[pageType];
        // Seeding/leeching lists reflect live tracker activity rather than a stable
        // snapshot, so entries can shift position between page fetches on a large list.
        const isLiveActivityList = pageType === 'seeding' || pageType === 'leeching';

        // Inject panel into page
        const panel = document.createElement('div');
        panel.id = 'coverup-batch-panel';
        panel.style.cssText = 'background:#1a1a1a;border:2px solid #4CAF50;border-radius:10px;padding:20px;margin:16px 0;font-family:sans-serif;color:#fff;';
        panel.innerHTML = `
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">
                <div style="font-size:16px;font-weight:bold;color:#4CAF50;">🔴 CoverUp — Batch Rehost (${pageTypeLabel})</div>
                <div style="display:flex;align-items:center;gap:8px;">
                    <button id="batch-start" style="padding:9px 22px;background:#4CAF50;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:bold;font-size:14px;">Scan &amp; rehost</button>
                    <button id="batch-stop" style="display:none;padding:9px 18px;background:#555;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:bold;font-size:14px;">Stop</button>
                    <button id="batch-panel-toggle" title="Hide the whole batch panel" style="padding:9px 18px;background:#555;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:bold;font-size:14px;flex-shrink:0;">Hide</button>
                </div>
            </div>
            <div id="batch-panel-body">
            <div style="background:#450a0a;border:1px solid #ef4444;border-radius:6px;padding:10px 12px;margin-bottom:10px;font-size:12px;color:#fca5a5;">
                <strong>⚠ Use at your own risk.</strong> Batch mode automatically updates torrent group metadata${pageType !== 'uploaded' ? ' — including releases you did not upload' : ''}.
                Always test with a small number first and check the results manually before running on all ${pageType}.
                ${isLiveActivityList ? `<br>⚠ ${pageTypeLabel} reflects live tracker activity, not a fixed list — it can shift while scanning a large one.` : ''}
            </div>
            <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:10px;">
                <div id="batch-status" style="font-size:13px;color:#aaa;flex:1;">
                    Scans your ${torrentsNoun} for covers that can be rehosted to RED's image host.
                    ptpimg images are checked against RED's own cache first. Covers already on RED are skipped.
                </div>
                <span id="batch-found-count" style="font-size:12px;color:#4CAF50;font-weight:bold;white-space:nowrap;">0 found so far</span>
            </div>
            ${renderBatchRunModeSelector()}
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;font-size:12px;color:#666;">
                <span id="batch-processed-count"></span>
                <a href="javascript:void(0)" id="batch-reset-page-processed" style="color:#555;text-decoration:underline;">Reset progress for this list only</a>
                <a href="javascript:void(0)" id="batch-reset-processed" style="color:#555;text-decoration:underline;">Reset all progress</a>
            </div>
            <div id="batch-progress-bar-wrap" style="display:none;background:#333;border-radius:4px;height:8px;margin-bottom:12px;">
                <div id="batch-progress-bar" style="background:#4CAF50;height:8px;border-radius:4px;width:0%;transition:width 0.3s;"></div>
            </div>
            <div id="batch-results" style="display:none;max-height:400px;overflow-y:auto;border:1px solid #333;border-radius:6px;"></div>
            </div>
        `;

        // Insert before the torrent table
        const torrentTable = document.querySelector('.torrent_table') || document.querySelector('#torrent_table') || document.querySelector('table.torrent');
        if (torrentTable) {
            torrentTable.parentNode.insertBefore(panel, torrentTable);
        } else {
            document.querySelector('#content')?.prepend(panel);
        }

        setupBatchPanelCollapse(panel);
        wireBatchRunModeSelector(panel);
        refreshProcessedCountDisplay();

        document.getElementById('batch-reset-page-processed').onclick = async () => {
            if (!confirm(`Re-check every group in your ${pageTypeLabel} list from scratch? Groups already confirmed fine or rehosted elsewhere are unaffected.`)) return;
            const link = document.getElementById('batch-reset-page-processed');
            const prevText = link.textContent;
            link.textContent = 'Fetching list…';
            const ids = await fetchAllGroupIdsForType(userId, apiKey, pageType, document.getElementById('batch-status'));
            const affected = removeGroupsFromProgress(ids);
            link.textContent = prevText;
            refreshProcessedCountDisplay();
            alert(`Cleared ${affected} group(s) in this list — they'll be re-checked on the next scan.`);
        };

        document.getElementById('batch-reset-processed').onclick = () => {
            if (confirm('Clear saved scan progress? All groups will be checked again from scratch next run.\n\n(Your all-time rehosted count is not affected.)')) {
                clearProcessedGroups();
                clearScannedGroups();
                clearFastScannedGroups();
                refreshProcessedCountDisplay();
            }
        };

        function triggerScan() {
            const { limit, ptpimgOnlyMode } = getBatchRunMode(panel);
            runBatchScan(userId, apiKey, limit, triggerScan, pageType, ptpimgOnlyMode);
        }
        document.getElementById('batch-start').onclick = triggerScan;

        document.getElementById('batch-stop').onclick = () => {
            batchStopRequested = true;
            const stopBtn = document.getElementById('batch-stop');
            stopBtn.disabled = true;
            stopBtn.textContent = 'Stopping…';
        };
    }

    async function runBatchScan(userId, apiKey, limit = Infinity, triggerScan, pageType = 'uploaded', ptpimgOnlyMode = false) {
        const startBtn  = document.getElementById('batch-start');
        const stopBtn   = document.getElementById('batch-stop');
        const statusEl  = document.getElementById('batch-status');
        const foundCountEl = document.getElementById('batch-found-count');
        const progressWrap = document.getElementById('batch-progress-bar-wrap');
        const progressBar  = document.getElementById('batch-progress-bar');
        const resultsEl = document.getElementById('batch-results');

        batchStopRequested = false;
        startBtn.disabled = true;
        startBtn.textContent = 'Scanning…';
        stopBtn.style.display = 'inline-block';
        stopBtn.disabled = false;
        stopBtn.textContent = 'Stop';
        progressWrap.style.display = 'block';
        resultsEl.style.display = 'block';
        resultsEl.innerHTML = '';
        foundCountEl.textContent = '0 found so far';

        // Step 1: collect all relevant torrent group IDs for this page type
        statusEl.textContent = 'Fetching torrent list…';
        const allGroupIds = await fetchAllGroupIdsForType(userId, apiKey, pageType, statusEl);

        const processedGroups   = getProcessedGroups();
        const scannedGroups     = getScannedGroups();
        const fastScannedGroups = getFastScannedGroups();

        // Filter out already-processed/already-scanned groups BEFORE shuffling —
        // guarantees a resumed run makes forward progress instead of randomly
        // resampling groups it already checked. Fast Mode also skips its own
        // shallow-checked set; Deep Mode ignores that set and checks everything.
        const unseenGroupIds = allGroupIds.filter(g => {
            const key = String(g);
            if (processedGroups.has(key) || scannedGroups.has(key)) return false;
            if (ptpimgOnlyMode && fastScannedGroups.has(key)) return false;
            return true;
        });
        const groupIds = [...unseenGroupIds].sort(() => Math.random() - 0.5);
        const scanLimit = limit < Infinity ? Math.min(limit * 10, groupIds.length) : groupIds.length;
        statusEl.textContent = `Found ${allGroupIds.length} groups (${groupIds.length} not yet checked). Randomly checking up to ${scanLimit}…`;

        const toRehost = [];
        const skipped  = { ptpimg: 0, alreadyRed: 0, noImage: 0 };
        const scannedThisRun     = [];
        const fastScannedThisRun = [];

        let scanned = 0;
        for (let i = 0; i < scanLimit; i++) {
            if (batchStopRequested) break;
            // Stop scanning early once we have enough candidates for the limit
            if (limit < Infinity && toRehost.length >= limit) break;

            const gid = groupIds[i];
            scanned++;

            progressBar.style.width = `${Math.round((scanned / scanLimit) * 50)}%`;
            statusEl.textContent = `Checking group ${scanned} of ${scanLimit}…`;
            foundCountEl.textContent = `${toRehost.length} found so far`;

            const groupData = await apiGet(`ajax.php?action=torrentgroup&id=${gid}`, apiKey);
            if (!groupData || groupData.status !== 'success') continue;

            const group = groupData.response.group;
            const imageUrl = (group.wikiImage || '').trim();
            const bbBody   = group.bbBody || group.wikiBody || '';

            // Check cover image field
            let coverNeedsRehost  = false;
            let queuedForRehost   = false;
            // Fast Mode only ever performs a shallow, partial check (ptpimg cache only) —
            // when it gives up on a group for that reason, that's not a real verdict, so
            // the group must stay eligible for a future Deep Mode run to properly assess.
            // Only genuinely-complete evaluations (in either mode) get marked "scanned".
            let shallowSkip = false;
            const descImgUrls = extractBBCodeImgUrls(bbBody).filter(needsDescriptionRehost);

            if (!imageUrl) {
                skipped.noImage++;
            } else {
                const h = (() => { try { return new URL(imageUrl).hostname.toLowerCase(); } catch(e) { return ''; } })();
                if (ptpimgOnlyMode && !h.includes('ptpimg.me')) {
                    // ptpimg-only mode: ignore every other category (already-RED thumbnail
                    // upgrades, imgur/pixhost/poor-quality, etc.) entirely for speed — but
                    // don't mark it scanned, since we never actually evaluated it.
                    shallowSkip = true;
                } else if (h.includes('redacted.sh') || h.includes('images.redacted.sh')) {
                    if (isRedThumbnailUrl(imageUrl)) {
                        // Already on RED, but stored as the lower-res /t/ thumbnail —
                        // upgrade to /i/ for free: no re-upload, just a URL swap.
                        toRehost.push({ gid, imageUrl: null, alreadyHosted: upgradeRedThumbnailUrl(imageUrl), descImgUrls, bbBody: descImgUrls.length > 0 ? bbBody : null, name: group.name || gid });
                        queuedForRehost = true;
                    } else {
                        skipped.alreadyRed++;
                    }
                } else if (h.includes('ptpimg.me')) {
                    // Try RED's own cache-recovery first (fast, single API call) before
                    // falling back to searching the release page for source links.
                    statusEl.textContent = `Checking group ${scanned} of ${scanLimit} — ptpimg detected, trying RED cache…`;
                    const recoveredUrl = await uploadUrlToRed(imageUrl, apiKey);
                    if (recoveredUrl) {
                        toRehost.push({ gid, imageUrl: null, alreadyHosted: recoveredUrl, descImgUrls, bbBody: descImgUrls.length > 0 ? bbBody : null, name: group.name || gid });
                        queuedForRehost = true;
                    } else if (ptpimgOnlyMode) {
                        // Fast mode: no cache hit means give up immediately — skip the
                        // slower page-scrape fallback entirely. This is a shallow check
                        // (cache only), so a later Deep Mode run should still get a shot
                        // at the source-link/streaming fallbacks — don't mark scanned.
                        skipped.ptpimg++;
                        shallowSkip = true;
                    } else {
                        statusEl.textContent = `Checking group ${scanned} of ${scanLimit} — checking source links…`;
                        const sourceImageUrl = await new Promise(res => fetchGroupPageAndResolveImage(gid, bbBody, res));
                        if (sourceImageUrl) {
                            toRehost.push({ gid, imageUrl: sourceImageUrl, descImgUrls, bbBody: descImgUrls.length > 0 ? bbBody : null, name: group.name || gid, viaSources: true });
                            queuedForRehost = true;
                        } else {
                            skipped.ptpimg++;
                        }
                    }
                } else if (!ptpimgOnlyMode && needsBatchRehost(imageUrl)) {
                    coverNeedsRehost = true;
                }
            }

            if (!ptpimgOnlyMode && !queuedForRehost && (coverNeedsRehost || descImgUrls.length > 0)) {
                toRehost.push({
                    gid,
                    imageUrl:     coverNeedsRehost ? imageUrl : null,
                    descImgUrls:  descImgUrls,
                    bbBody:       descImgUrls.length > 0 ? bbBody : null,
                    name:         group.name || gid,
                });
                queuedForRehost = true;
            }

            // Groups queued for rehosting stay eligible until actually rehosted, so an
            // interrupted run rediscovers them. Fully-checked, nothing-to-do groups get
            // marked "scanned" (skipped by all future runs). Shallow Fast Mode gives-ups
            // go into the separate fast-only set instead, so repeated Fast Mode runs
            // don't re-examine them every time, while Deep Mode still gets a proper look.
            if (!queuedForRehost) {
                if (shallowSkip) {
                    fastScannedThisRun.push(gid);
                } else {
                    scannedThisRun.push(gid);
                }
            }
        }

        addScannedGroups(scannedThisRun);
        addFastScannedGroups(fastScannedThisRun);

        const stoppedDuringScan = batchStopRequested;
        stopBtn.style.display = 'none';

        // Step 2: apply limit then show results
        const toRehostFinal = toRehost.slice(0, limit);
        const limitedNote = limit < Infinity ? ` (test mode: first ${toRehostFinal.length})` : '';
        statusEl.textContent = `Found ${toRehost.length} eligible covers${limitedNote}. ${skipped.ptpimg} ptpimg (unrecoverable), ${skipped.alreadyRed} already on RED, ${skipped.noImage} no image.${stoppedDuringScan ? ' Stopped early.' : ''}`;
        foundCountEl.textContent = `${toRehost.length} found so far`;

        if (toRehostFinal.length === 0) {
            progressBar.style.width = '100%';
            startBtn.disabled = false;
            startBtn.textContent = 'Scan again';
            startBtn.onclick = triggerScan;
            refreshProcessedCountDisplay();
            return;
        }

        // Render result rows
        resultsEl.innerHTML = toRehostFinal.map((item, idx) => {
            const parts = [];
            if (item.imageUrl) parts.push(`cover: ${escHtml(item.imageUrl)}`);
            if (item.alreadyHosted) parts.push(`cover: ${escHtml(item.alreadyHosted)} (recovered from RED cache)`);
            if (item.descImgUrls && item.descImgUrls.length) parts.push(`${item.descImgUrls.length} description image(s)`);
            return `
            <div id="batch-row-${idx}" style="display:flex;align-items:center;gap:10px;padding:8px 12px;border-bottom:1px solid #222;font-size:12px;">
                <div style="flex:1;min-width:0;">
                    <a href="/torrents.php?id=${item.gid}" target="_blank" style="color:#4CAF50;text-decoration:none;">${escHtml(item.name)}</a>
                    <div style="color:#666;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${parts.join(' · ')}</div>
                </div>
                <span id="batch-status-${idx}" style="white-space:nowrap;color:#888;">queued</span>
            </div>`;
        }).join('');

        // Step 3: rehost each — only runs immediately on an uninterrupted scan; if the
        // user hit Stop, this waits for an explicit click on "Rehost N found so far".
        async function doRehostNow() {
            batchStopRequested = false;
            startBtn.disabled = true;
            startBtn.textContent = 'Rehosting…';
            stopBtn.style.display = 'inline-block'; stopBtn.disabled = false; stopBtn.textContent = 'Stop';

            let done = 0;
            for (let i = 0; i < toRehostFinal.length; i++) {
                if (batchStopRequested) break;
                const { gid, imageUrl, alreadyHosted, descImgUrls, bbBody, name } = toRehostFinal[i];
                const rowStatus = document.getElementById(`batch-status-${i}`);
                rowStatus.textContent = 'uploading…';
                rowStatus.style.color = 'orange';

                progressBar.style.width = `${Math.round(50 + (i / toRehostFinal.length) * 50)}%`;
                statusEl.textContent = `Rehosting ${i + 1} of ${toRehostFinal.length}: ${name}`;

                try {
                    let postParams = [];
                    let anyFailed = false;

                    // Rehost cover image if needed
                    if (alreadyHosted) {
                        postParams.push(`image=${encodeURIComponent(alreadyHosted)}`);
                    } else if (imageUrl) {
                        const newUrl = await batchUploadWithDeadSourceFallback(imageUrl, gid, apiKey);
                        if (newUrl) {
                            postParams.push(`image=${encodeURIComponent(newUrl)}`);
                        } else {
                            anyFailed = true;
                        }
                    }

                    // Rehost description [img] URLs if needed
                    if (descImgUrls && descImgUrls.length && bbBody) {
                        let updatedBody = bbBody;
                        for (const oldImgUrl of descImgUrls) {
                            const newImgUrl = await batchUploadImage(oldImgUrl, apiKey);
                            if (newImgUrl) {
                                // Replace all occurrences of this URL in the body
                                updatedBody = updatedBody.split(oldImgUrl).join(newImgUrl);
                            } else {
                                anyFailed = true;
                            }
                        }
                        if (updatedBody !== bbBody) {
                            postParams.push(`body=${encodeURIComponent(updatedBody)}`);
                        }
                    }

                    if (postParams.length > 0) {
                        postParams.push(`summary=${encodeURIComponent('Images rehosted to RED image host via CoverUp')}`);
                        await apiPost(`ajax.php?action=groupedit&id=${gid}`, apiKey, postParams.join('&'));
                        rowStatus.textContent = anyFailed ? '⚠ partial' : '✓ rehosted';
                        rowStatus.style.color  = anyFailed ? '#f59e0b' : '#4CAF50';
                        if (!anyFailed) {
                            done++;
                            addProcessedGroup(gid);
                        }
                    } else {
                        rowStatus.textContent = '✗ upload failed';
                        rowStatus.style.color = '#ff4444';
                    }
                } catch(e) {
                    rowStatus.textContent = '✗ error';
                    rowStatus.style.color = '#ff4444';
                }

            }

            progressBar.style.width = '100%';
            statusEl.textContent = `Done! ${done} of ${toRehostFinal.length} covers rehosted to RED. ${toRehostFinal.length - done} failed.${batchStopRequested ? ' Stopped early.' : ''}`;
            startBtn.disabled = false;
            startBtn.textContent = 'Scan again';
            startBtn.onclick = triggerScan;
            stopBtn.style.display = 'none';
            refreshProcessedCountDisplay();
        }

        if (stoppedDuringScan) {
            // Pause instead of auto-continuing — the user must explicitly confirm
            // rehosting whatever was found before the stop.
            startBtn.disabled = false;
            startBtn.textContent = `Rehost ${toRehostFinal.length} found so far`;
            startBtn.onclick = doRehostNow;
        } else {
            await doRehostNow();
        }
    }

    // Fetches group IDs for any of RED's user_torrents "type" values (uploaded,
    // seeding, snatched). Gazelle's convention is that the response key matches the
    // requested type (e.g. response.uploaded, response.seeding, response.snatched),
    // with each entry carrying a groupId. Falls back defensively across a couple of
    // plausible field-name variants and logs once if the shape is unrecognized, so any
    // tracker-side quirk is debuggable from the console rather than silently dropping
    // everything.
    async function fetchAllGroupIdsForType(userId, apiKey, type, statusEl) {
        const groupIds = new Set();
        let offset = 0;
        const limit = 500;
        let loggedUnknownShape = false;
        while (true) {
            // action=user_torrents has been observed to intermittently return a
            // transient failure response (confirmed live for both seeding and leeching —
            // not type-specific) even for a valid request. Retry a couple of times before
            // giving up, so a single flaky response doesn't silently truncate the list.
            let data = null;
            for (let attempt = 0; attempt < 3 && !data; attempt++) {
                const attemptData = await apiGet(`ajax.php?action=user_torrents&id=${userId}&type=${type}&limit=${limit}&offset=${offset}`, apiKey);
                if (attemptData && attemptData.status === 'success') { data = attemptData; }
                else if (attempt < 2) { await sleep(1200); }
            }
            if (!data) {
                console.warn(`[CoverUp] user_torrents fetch failed after retries for type=${type} at offset=${offset} — list may be incomplete.`);
                statusEl.textContent = `Fetched ${groupIds.size} groups so far (a page failed to load after retries — list may be incomplete)…`;
                break;
            }
            const list = (data.response && (data.response[type] || data.response.torrents)) || [];
            if (!Array.isArray(list) || list.length === 0) break;
            list.forEach(t => {
                const gid = t.groupId ?? t.groupID ?? (t.group && t.group.id) ?? null;
                if (gid != null) {
                    groupIds.add(String(gid));
                } else if (!loggedUnknownShape) {
                    console.warn(`[CoverUp] Unexpected user_torrents entry shape for type=${type} — no groupId found:`, t);
                    loggedUnknownShape = true;
                }
            });
            if (list.length < limit) break;
            offset += limit;
            statusEl.textContent = `Fetched ${groupIds.size} groups so far…`;
        }
        return [...groupIds];
    }

    // 429s are retried with the server's requested Retry-After delay, but capped —
    // without a cap, a stretch of repeated 429s (or a malformed/huge Retry-After
    // value) would retry silently forever with nothing in the console to explain it,
    // which looks exactly like a stalled scan. Logging each 429 means a future stall
    // is actually diagnosable instead of just going quiet.
    const API_429_MAX_RETRIES = 4;
    function apiGet(url, apiKey, retryCount = 0) {
        return redApiThrottle().then(() => new Promise((resolve) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: `https://redacted.sh/${url}`,
                headers: { 'Authorization': apiKey },
                timeout: 15000,
                onload: function(r) {
                    if (r.status === 429) {
                        const retryAfter = parseInt(r.responseHeaders.match(/retry-after:\s*(\d+)/i)?.[1] || '10') * 1000;
                        if (retryCount >= API_429_MAX_RETRIES) {
                            console.warn(`[CoverUp] apiGet giving up after ${retryCount} × 429 for`, url);
                            resolve(null);
                            return;
                        }
                        console.warn(`[CoverUp] apiGet got 429, retrying in ${retryAfter}ms (attempt ${retryCount + 1}/${API_429_MAX_RETRIES}):`, url);
                        sleep(retryAfter).then(() => apiGet(url, apiKey, retryCount + 1).then(resolve));
                        return;
                    }
                    try { resolve(JSON.parse(r.responseText)); }
                    catch(e) { resolve(null); }
                },
                onerror:   () => resolve(null),
                ontimeout: () => resolve(null),
            });
        }));
    }

    function apiPost(url, apiKey, body, retryCount = 0) {
        return redApiThrottle().then(() => new Promise((resolve) => {
            GM_xmlhttpRequest({
                method: 'POST',
                url: `https://redacted.sh/${url}`,
                headers: { 'Authorization': apiKey, 'Content-Type': 'application/x-www-form-urlencoded' },
                data: body,
                timeout: 15000,
                onload: function(r) {
                    if (r.status === 429) {
                        const retryAfter = parseInt(r.responseHeaders.match(/retry-after:\s*(\d+)/i)?.[1] || '10') * 1000;
                        if (retryCount >= API_429_MAX_RETRIES) {
                            console.warn(`[CoverUp] apiPost giving up after ${retryCount} × 429 for`, url);
                            resolve(null);
                            return;
                        }
                        console.warn(`[CoverUp] apiPost got 429, retrying in ${retryAfter}ms (attempt ${retryCount + 1}/${API_429_MAX_RETRIES}):`, url);
                        sleep(retryAfter).then(() => apiPost(url, apiKey, body, retryCount + 1).then(resolve));
                        return;
                    }
                    try { resolve(JSON.parse(r.responseText)); }
                    catch(e) { resolve(null); }
                },
                onerror:   () => resolve(null),
                ontimeout: () => resolve(null),
            });
        }));
    }

    function uploadUrlToRed(imageUrl, apiKey, retryCount = 0) {
        return redApiThrottle().then(() => new Promise((resolve) => {
            const fd = new FormData();
            fd.append('url', imageUrl);
            GM_xmlhttpRequest({
                method: 'POST',
                url: 'https://redacted.sh/ajax.php?action=upload_image',
                headers: { 'Authorization': apiKey },
                data: fd,
                timeout: 20000,
                onload: function(r) {
                    if (r.status === 429) {
                        const retryAfter = parseInt(r.responseHeaders.match(/retry-after:\s*(\d+)/i)?.[1] || '10') * 1000;
                        if (retryCount >= API_429_MAX_RETRIES) {
                            console.warn(`[CoverUp] uploadUrlToRed giving up after ${retryCount} × 429 for`, imageUrl);
                            resolve(null);
                            return;
                        }
                        console.warn(`[CoverUp] uploadUrlToRed got 429, retrying in ${retryAfter}ms (attempt ${retryCount + 1}/${API_429_MAX_RETRIES}):`, imageUrl);
                        sleep(retryAfter).then(() => uploadUrlToRed(imageUrl, apiKey, retryCount + 1).then(resolve));
                        return;
                    }
                    try {
                        const data = JSON.parse(r.responseText);
                        if (data.status === 'success' && data.response && data.response.url) {
                            resolve(data.response.url);
                        } else {
                            // This was silent before — the very first attempt in the chain
                            // failing with zero logged reason is exactly why a batch upload
                            // failure was impossible to diagnose. RED rejecting its own
                            // server-side fetch (e.g. "unrecognized magic bytes" when a host's
                            // anti-bot protection serves it a challenge page instead of the
                            // real image) is expected sometimes — this just makes it visible.
                            console.warn('[CoverUp] uploadUrlToRed: RED rejected server-side fetch for', imageUrl, '—', r.responseText.slice(0, 300));
                            resolve(null);
                        }
                    } catch(e) {
                        console.warn('[CoverUp] uploadUrlToRed: parse error for', imageUrl, e, r.responseText.slice(0, 200));
                        resolve(null);
                    }
                },
                onerror:   () => { console.warn('[CoverUp] uploadUrlToRed: network error fetching', imageUrl); resolve(null); },
                ontimeout: () => { console.warn('[CoverUp] uploadUrlToRed: RED server-side fetch timed out (20s) for', imageUrl); resolve(null); },
            });
        }));
    }

    // Client-side fetch + re-upload, for CDNs (Apple Music/mzstatic, Spotify, Tidal,
    // Deezer, Bandcamp, Amazon, Qobuz, Discogs, MusicBrainz, Beatport, ...) whose servers
    // often reject RED's own server-side fetch-by-URL (upload_image with url=...) as
    // hotlinking/bot traffic, but which serve the image fine to a real browser request.
    // Mirrors what the manual picker's processImage() does: GM_xmlhttpRequest fetches the
    // bytes through the browser, then those bytes (not the URL) are handed to RED.
    function uploadUrlToRedClientFetch(imageUrl, apiKey) {
        return new Promise((resolve) => {
            GM_xmlhttpRequest({
                method: 'GET', url: imageUrl, responseType: 'blob',
                headers: { 'Accept': 'image/jpeg,image/png,image/*,*/*' },
                timeout: 20000,
                onload: function(response) {
                    if (!response.response) {
                        console.warn('[CoverUp] uploadUrlToRedClientFetch: empty response body for', imageUrl);
                        resolve(null);
                        return;
                    }
                    uploadToRedImageHost(response.response, resolve);
                },
                onerror:   () => { console.warn('[CoverUp] uploadUrlToRedClientFetch: network error fetching', imageUrl); resolve(null); },
                ontimeout: () => { console.warn('[CoverUp] uploadUrlToRedClientFetch: browser fetch timed out (20s) for', imageUrl); resolve(null); },
            });
        });
    }

    // Apple/mzstatic is the one host we've directly confirmed always rejects RED's
    // server-side fetch-by-URL — skip straight to the client-fetch path for it so we
    // don't pay for a guaranteed-failed attempt (and its timeout) every time.
    const CONFIRMED_SERVER_FETCH_BLOCKED_RE = /apple\.com|mzstatic\.com/i;

    // Batch mode's single entry point for uploading a source image to RED. Tries the
    // fast server-side URL upload first for everything else — most hosts (including
    // several we'd only assumed were problematic) upload fine this way — and only
    // falls back to the slower client-fetch-then-upload path if that specific attempt
    // actually fails. Same eventual result either way, just fewer wasted round trips.
    // Every individual network call in the chain below (server-side fetch, client
    // fetch, the actual upload POST) already has its own 20s timeout — chained
    // serially that's up to 60s worst case. This hard ceiling exists only to guarantee
    // the whole chain gives up by a fixed point no matter what (so one truly hung host
    // can never freeze the rest of the batch) — it must stay comfortably above that
    // 60s worst case, or it cuts off a still-in-progress fallback that would have
    // succeeded (confirmed: a real batch run showed the earlier 45s cap doing exactly
    // that — killing the working client-fetch fallback before it could finish because
    // the first, failing attempt had already used up half the budget).
    const BATCH_UPLOAD_HARD_TIMEOUT_MS = 70000;
    function batchUploadImage(imageUrl, apiKey) {
        const attempt = CONFIRMED_SERVER_FETCH_BLOCKED_RE.test(imageUrl)
            ? uploadUrlToRedClientFetch(imageUrl, apiKey)
            : uploadUrlToRed(imageUrl, apiKey).then(url => {
                  if (url) return url;
                  return uploadUrlToRedClientFetch(imageUrl, apiKey);
              });

        return Promise.race([
            attempt,
            new Promise(resolve => setTimeout(() => {
                console.warn(`[CoverUp] batchUploadImage: giving up after ${BATCH_UPLOAD_HARD_TIMEOUT_MS}ms with no response from any upload path for`, imageUrl);
                resolve(null);
            }, BATCH_UPLOAD_HARD_TIMEOUT_MS)),
        ]);
    }

    // A stored cover on a "source domain" (Discogs, MusicBrainz, mzstatic,
    // coverartarchive.org, etc.) is expected to still be reachable when batch mode
    // goes to move it to RED — that's the whole reason it was flagged as needing a
    // rehost in the first place. But confirmed live: an individual link on these can
    // go dead (the specific image removed, an MBID's art pulled, etc.) even though the
    // service itself is fine — RED can't fetch it, and neither can we.
    // Cover Art Archive's JSON API returns image URLs hosted directly on Internet
    // Archive's own storage nodes (e.g. ia803407.us.archive.org/.../mbid-<uuid>/...),
    // not necessarily on coverartarchive.org itself — confirmed live with a dead
    // ia*.us.archive.org link. Same underlying resource family, same failure mode, so
    // both need to count as "circular" here, not just the coverartarchive.org domain.
    function isCoverArtArchiveUrl(url) {
        try {
            const h = new URL(url).hostname.toLowerCase();
            return h.includes('coverartarchive.org') || h === 'archive.org' || h.endsWith('.archive.org');
        } catch(e) { return false; }
    }
    async function batchUploadWithDeadSourceFallback(imageUrl, gid, apiKey) {
        const uploaded = await batchUploadImage(imageUrl, apiKey);
        if (uploaded) return uploaded;

        console.warn('[CoverUp] stored cover failed to upload — trying source-link fallback for gid', gid, ':', imageUrl);
        const groupData = await apiGet(`ajax.php?action=torrentgroup&id=${gid}`, apiKey);
        const group = (groupData && groupData.status === 'success') ? groupData.response.group : null;
        const bbBody = group ? (group.bbBody || group.wikiBody || '') : '';

        if (bbBody) {
            const sourceImageUrl = await new Promise(res => fetchGroupPageAndResolveImage(gid, bbBody, res));
            // A "alternative" that's still on coverartarchive.org isn't actually an
            // alternative — a MusicBrainz description link resolves through the exact
            // same coverartarchive lookup as the original dead cover, so retrying it
            // just rediscovers the same dead (or equally unreliable) resource. Only
            // worth uploading if it's a genuinely different source than the one that
            // already failed.
            const isCircular = sourceImageUrl && isCoverArtArchiveUrl(imageUrl) && isCoverArtArchiveUrl(sourceImageUrl);
            if (sourceImageUrl && !isCircular) {
                const uploaded2 = await batchUploadImage(sourceImageUrl, apiKey);
                if (uploaded2) return uploaded2;
            }
        }

        // Confirmed truly dead at this point — no usable description link, or the
        // only one found just leads back to the same broken coverartarchive resource.
        // Last resort: search streaming sources directly (Deezer/Qobuz/Bandcamp are
        // independent of coverartarchive) and use the best match — automatic, matching
        // the rest of this fallback chain, since there's no way to pause for manual
        // approval mid-upload.
        if (group) {
            const artist = (group.musicInfo && group.musicInfo.artists && group.musicInfo.artists[0]) ? group.musicInfo.artists[0].name : '';
            const albumInfo = { artist, album: group.name || String(gid), year: String(group.year || '') };
            const candidates = await new Promise(res => searchStreamingForApproval(albumInfo, res));
            if (candidates && candidates.length > 0) {
                console.warn('[CoverUp] source confirmed dead for gid', gid, '— using streaming search result instead:', candidates[0].imageUrl);
                return await batchUploadImage(candidates[0].imageUrl, apiKey);
            }
        }
        return null;
    }

    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    // The 🎲 Random Collage button (on collages.php) links to random.php?action=collage,
    // which occasionally lands on a since-deleted collage — RED redirects that to a
    // log.php search results page ("Collage NNNNN was deleted…") instead of a collage
    // page, so CoverUp's own collage panel (which only renders on collages.php) isn't
    // there anymore to re-roll from. This detects that specific dead-end and drops the
    // same random-collage link onto it, so there's no need to navigate back first.
    function setupDeletedCollageRandomButton() {
        if (!/log\.php/.test(window.location.pathname)) return;
        const searchParam = new URL(window.location.href).searchParams.get('search') || '';
        if (!/^Collage\s+\d+$/i.test(searchParam.trim())) return;
        if (document.getElementById('coverup-deleted-collage-retry')) return;

        const box = document.createElement('div');
        box.id = 'coverup-deleted-collage-retry';
        box.style.cssText = 'background:#1a1a1a;border:2px solid #4CAF50;border-radius:10px;padding:14px 18px;margin:16px 0;font-family:sans-serif;color:#fff;display:flex;align-items:center;gap:12px;';
        box.innerHTML = `
            <div style="color:#aaa;font-size:13px;">🔴 CoverUp — that random collage is gone (deleted).</div>
            <a href="https://redacted.sh/random.php?action=collage" style="padding:9px 14px;background:#4CAF50;color:#fff;border-radius:6px;font-weight:bold;font-size:14px;text-decoration:none;white-space:nowrap;">🎲 Try Another Random Collage</a>
        `;

        const target = document.querySelector('.thin') || document.querySelector('#content');
        if (target) target.prepend(box);
        else document.body.prepend(box);
    }

    setupBatchRehostPanel();
    setupCollageBatchPanel();
    setupGeneralCollageBrowseBatchPanel();
    setupSingleCollageBatchPanel();
    setupArtistBatchPanel();
    setupBetterArtworkBatchPanel();
    setupBetterCoverBatchPanel();
    setupPasteListBatchPanel();
    setupDeletedCollageRandomButton();

    // ============================================================
    // --- RECOVER BUTTON IN SITE NAV ---
    // ============================================================
    // Adds a "ReCover uploads" button to the RED nav bar, visible on all pages,
    // only when a RED API key is configured.
    // Fetch a release page and resolve its best non-Discogs source image URL
    // Priority: Apple Music > Deezer > Qobuz > Bandcamp > Tidal > Spotify > Amazon
    const SOURCE_PRIORITY = ['Apple Music', 'Spotify', 'Qobuz', 'Deezer', 'Bandcamp', 'Tidal', 'Amazon', 'Beatport', 'Discogs Direct'];

    function extractSourceLinksFromHtml(html) {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const links = [];
        const seen  = new Set();
        doc.querySelectorAll('a[href]').forEach(a => {
            // Use getAttribute to get the raw href — a.href resolves relative to about:blank in sandbox
            const rawHref = a.getAttribute('href') || '';
            const href = rawHref.startsWith('http') ? rawHref : ('https://redacted.sh' + (rawHref.startsWith('/') ? rawHref : '/' + rawHref));
            if (!href || seen.has(href)) return;
            seen.add(href);
            if      (/musicbrainz\.org\/release\/[a-f0-9-]{36}/i.test(href))   links.push({ href, source: 'MusicBrainz' });
            else if (/(?:open\.)?qobuz\.com\/(?:[a-z]{2}-[a-z]{2}\/)?album\//i.test(href)) links.push({ href, source: 'Qobuz' });
            else if (/music\.apple\.com.*\/album/i.test(href) || /itunes\.apple\.com.*\/album/i.test(href)) links.push({ href, source: 'Apple Music' });
            else if (/\.bandcamp\.com|bandcamp\.com\/(album|music)/i.test(href)) links.push({ href, source: 'Bandcamp' });
            else if (/deezer\.com\/(?:\w+\/)?album\/\d+/i.test(href))         links.push({ href, source: 'Deezer' });
            else if (/tidal\.com\/(album|browse\/album)/i.test(href))           links.push({ href, source: 'Tidal' });
            else if (/open\.spotify\.com\/album/i.test(href))                   links.push({ href, source: 'Spotify' });
            else if (/amazon\.(com|co\.uk|de|fr).*\/(dp|gp\/product)/i.test(href)) links.push({ href, source: 'Amazon' });
            else if (/beatport\.com\/(release|track)\//i.test(href))            links.push({ href, source: 'Beatport' });
        });
        // Sort by priority
        return links.sort((a, b) => {
            const ai = SOURCE_PRIORITY.indexOf(a.source);
            const bi = SOURCE_PRIORITY.indexOf(b.source);
            return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
        });
    }

    function resolveFirstSourceImage(links, callback) {
        if (!links.length) { callback(null); return; }
        const [link, ...rest] = links;
        console.log('[CoverUp] trying source:', link.source, link.href);
        let called = false;
        resolveSourceImage(link, result => {
            console.log('[CoverUp] source result:', link.source, result ? result.imageUrl : null);
            if (called) return;
            if (result && result.imageUrl) {
                called = true;
                callback(result.imageUrl);
            } else if (!called) {
                called = true;
                resolveFirstSourceImage(rest, callback);
            }
        });
        setTimeout(() => {
            if (!called) {
                console.log('[CoverUp] source timeout:', link.source);
                called = true;
                resolveFirstSourceImage(rest, callback);
            }
        }, 12000);
    }

    // Extract source links from raw BBCode text (for batch mode where React hasn't rendered)
    // Search streaming sources for a release and return image candidates for manual approval
    // Shared relevance filter — mirrors the manual picker's own isRelevant() (kept as
    // a separate, untouched copy there since that flow is already proven; this
    // standalone version exists so batch mode's automated search can filter out
    // obviously-wrong matches too, since here a bad top result can get auto-uploaded
    // with no human eyeballing it first).
    function isRelevantSearchResult(albumInfo, resultTitle, resultArtist) {
        const VA_PATTERN  = /^(unknown artist|various artists?|va|various|multiple artists?)$/i;
        const searchArtist = (albumInfo.artist || '').trim().toLowerCase();
        const searchAlbum  = (albumInfo.album  || '').trim().toLowerCase();
        const isVA = !searchArtist || VA_PATTERN.test(searchArtist);
        const ra = (resultArtist || '').toLowerCase();
        const rt = (resultTitle  || '').toLowerCase();

        function wordsOf(s) { return (s || '').toLowerCase().split(/[\s\-&,]+/).filter(w => w.length > 2); }
        function anyWordMatches(needle, haystack) {
            const nw = wordsOf(needle);
            if (!nw.length) return true;
            return nw.some(w => haystack.toLowerCase().includes(w));
        }

        if (!isVA && searchArtist) {
            if (ra) {
                if (!anyWordMatches(searchArtist, ra)) return false;
            } else if (searchAlbum && !anyWordMatches(searchAlbum, rt)) {
                return false;
            }
        }

        if (searchAlbum) {
            const distinctiveWords = wordsOf(searchAlbum).filter(w => w.length > 4);
            if (distinctiveWords.length > 0) {
                if (!distinctiveWords.some(w => rt.includes(w))) return false;
            } else {
                const escaped = searchAlbum.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const pattern = new RegExp('(?:^|[\\s\\-–—:])' + escaped + '(?:$|[\\s\\-–—:(])', 'i');
                if (!pattern.test(rt)) return false;
            }
        }

        return true;
    }

    // The manual "Select Artwork" picker searches four tiers: Page Sources, Discogs
    // Search, Deezer/Qobuz/MusicBrainz/Bandcamp, and iTunes/Amazon. Batch mode's
    // automated fallback previously only covered the streaming tier — confirmed live:
    // a release whose only real match was on iTunes/Amazon/Discogs failed in batch but
    // was found immediately by opening the manual picker for the same release. Brought
    // up to the same breadth here so batch mode doesn't systematically miss what the
    // manual flow finds fine.
    function searchStreamingForApproval(albumInfo, callback) {
        const results = [];
        let done = 0;
        const hasDiscogsToken = !!getDiscogsToken();
        const SOURCES = hasDiscogsToken ? 7 : 6;
        function finish() {
            done++;
            if (done === SOURCES) callback(results.filter(r => isRelevantSearchResult(albumInfo, r.label, '')));
        }

        // Each search function returns items in its own format — normalise to { imageUrl, label, searchSource }
        searchDeezer(albumInfo, items => {
            if (items) items.slice(0, 3).forEach(i => {
                // Deezer items have cover_xl, cover_big, cover, or cover_medium
                const url = i.cover_xl || i.cover_big || i.cover_medium || i.cover || (i.id ? `https://api.deezer.com/album/${i.id}/image` : null);
                if (url) results.push({ imageUrl: url, label: i.title || '', searchSource: 'Deezer' });
            });
            finish();
        });
        searchQobuz(albumInfo, items => {
            if (items) items.slice(0, 3).forEach(i => {
                // Qobuz items have image.large / image.small (raw API format)
                const url = (i.image && (i.image.large || i.image.small)) || i.imageUrl;
                if (url) results.push({ imageUrl: url, label: i.title || '', searchSource: 'Qobuz' });
            });
            finish();
        });
        searchMusicBrainz(albumInfo, items => {
            if (items) items.slice(0, 3).forEach(i => {
                const url = i.imageUrl || i.thumbnailUrl;
                if (url) results.push({ imageUrl: url, label: i.title || '', searchSource: 'MusicBrainz' });
            });
            finish();
        });
        searchBandcamp(albumInfo, items => {
            if (items) items.slice(0, 3).forEach(i => {
                const url = i.imageUrl || i.art_url;
                if (url) results.push({ imageUrl: url, label: i.title || '', searchSource: 'Bandcamp' });
            });
            finish();
        });
        searchItunes(albumInfo, items => {
            if (items) items.slice(0, 3).forEach(i => {
                if (!i.artworkUrl100) return;
                const url = i.artworkUrl100.replace(/\d+x\d+bb\.jpg$/, '10000x10000bb.jpg').replace(/\d+x\d+\.jpg$/, '10000x10000.jpg');
                results.push({ imageUrl: url, label: i.collectionName || '', searchSource: 'iTunes' });
            });
            finish();
        });
        searchAmazon(albumInfo, items => {
            if (items) items.slice(0, 3).forEach(i => {
                if (i.imageUrl) results.push({ imageUrl: i.imageUrl, label: i.title || '', searchSource: 'Amazon' });
            });
            finish();
        });
        if (hasDiscogsToken) {
            const searchQuery = `${albumInfo.artist || ''} ${albumInfo.album || ''} ${albumInfo.year || ''}`.trim();
            searchDiscogs(searchQuery, items => {
                if (items) items.slice(0, 3).forEach(r => {
                    if (r._allImages && r._allImages.length > 0) {
                        results.push({ imageUrl: r._allImages[0].uri, label: r.title || '', searchSource: 'Discogs' });
                    } else if (r.cover_image && !r.cover_image.includes('spacer.gif')) {
                        results.push({ imageUrl: r.cover_image, label: r.title || '', searchSource: 'Discogs' });
                    }
                });
                finish();
            }, albumInfo);
        }
    }

    function extractSourceLinksFromBBCode(bbcode) {
        const links = [];
        const seen  = new Set();
        // Match URLs in [url=...] tags and bare URLs
        const urlRe = /(?:\[url=|\[url\])?(?:https?:\/\/[^\]\s"<]+)/gi;
        let m;
        while ((m = urlRe.exec(bbcode)) !== null) {
            let href = m[0].replace(/^\[url=/, '').replace(/^\[url\]/, '').trim();
            if (!href.startsWith('http')) continue;
            if (seen.has(href)) continue;
            seen.add(href);
            if      (/discogs\.com\/(?:[^/]+\/)*(?:release|master)\/\d+/i.test(href)) links.push({ href, source: 'Discogs Direct' });
            else if (/musicbrainz\.org\/release\/[a-f0-9-]{36}/i.test(href))            links.push({ href, source: 'MusicBrainz' });
            else if (/(?:open\.)?qobuz\.com\/(?:[a-z]{2}-[a-z]{2}\/)?album\//i.test(href)) links.push({ href, source: 'Qobuz' });
            else if (/music\.apple\.com.*\/album/i.test(href) || /itunes\.apple\.com.*\/album/i.test(href)) links.push({ href, source: 'Apple Music' });
            else if (/\.bandcamp\.com|bandcamp\.com\/(album|music)/i.test(href))        links.push({ href, source: 'Bandcamp' });
            else if (/deezer\.com\/(?:\w+\/)?album\/\d+/i.test(href))                links.push({ href, source: 'Deezer' });
            else if (/tidal\.com\/(album|browse\/album)/i.test(href))                   links.push({ href, source: 'Tidal' });
            else if (/open\.spotify\.com\/album/i.test(href))                           links.push({ href, source: 'Spotify' });
            else if (/amazon\.(com|co\.uk|de|fr).*\/(dp|gp\/product)/i.test(href))    links.push({ href, source: 'Amazon' });
            else if (/beatport\.com\/(release|track)\//i.test(href))                    links.push({ href, source: 'Beatport' });
        }
        // Sort by priority
        return links.sort((a, b) => {
            const ai = SOURCE_PRIORITY.indexOf(a.source);
            const bi = SOURCE_PRIORITY.indexOf(b.source);
            return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
        });
    }

    function fetchGroupPageAndResolveImage(gid, bbBody, callback) {
        // Use BBCode directly if available (avoids React-rendered page issue)
        if (bbBody) {
            const links = extractSourceLinksFromBBCode(bbBody);
            console.log('[CoverUp] BBCode source links for gid', gid, ':', links.map(l => l.source + ':' + l.href.slice(0,50)));
            if (links.length) { resolveFirstSourceImage(links, callback); return; }
        }
        // Fallback: fetch the torrentgroup API for bbBody if not already provided
        apiGet(`ajax.php?action=torrentgroup&id=${gid}`, getRedApiKey()).then(data => {
            if (!data || data.status !== 'success') { callback(null); return; }
            const bb = data.response.group.bbBody || data.response.group.wikiBody || '';
            if (!bb) { callback(null); return; }
            const links = extractSourceLinksFromBBCode(bb);
            console.log('[CoverUp] API BBCode source links for gid', gid, ':', links.map(l => l.source + ':' + l.href.slice(0,50)));
            if (links.length) { resolveFirstSourceImage(links, callback); }
            else { callback(null); }
        });
    }

    // ============================================================
    // --- COLLAGE DESCRIPTION IMAGE FIX (geoblocked/rehostable [img] tags) ---
    // ============================================================
    // Not part of the documented ajax.php API — same undocumented cookie-form pattern
    // as the artist-image edit above. The edit page is fetched first so the existing
    // category/tags/reverseorder values can be resubmitted unchanged alongside the
    // updated description; omitting them would blank/reset those fields.
    function fetchCollageEditFormData(collageId, cb) {
        GM_xmlhttpRequest({
            method: 'GET',
            url: 'collages.php?action=edit&collageid=' + collageId,
            timeout: 15000,
            onload: function(r) {
                try {
                    const doc = new DOMParser().parseFromString(r.responseText, 'text/html');
                    const form = [...doc.querySelectorAll('form')].find(f => {
                        const actionInput = f.querySelector('input[name="action"]');
                        return actionInput && actionInput.value === 'edit_handle' && f.querySelector('input[name="collageid"]');
                    });
                    if (!form) { cb(null); return; }
                    const authInput = form.querySelector('input[name="auth"]');
                    const categoryEl = form.querySelector('select[name="category"]');
                    const descEl = form.querySelector('textarea[name="description"]');
                    const tagsEl = form.querySelector('input[name="tags"]');
                    const reverseEl = form.querySelector('input[name="reverseorder"]');
                    cb({
                        auth: authInput ? authInput.value : null,
                        category: categoryEl ? categoryEl.value : '',
                        description: descEl ? descEl.value : '',
                        tags: tagsEl ? tagsEl.value : '',
                        reverseChecked: reverseEl ? reverseEl.checked : false,
                    });
                } catch(e) { cb(null); }
            },
            onerror: function() { cb(null); },
            ontimeout: function() { cb(null); },
        });
    }

    function submitCollageDescription(collageId, newDescription, formData, cb) {
        const fd = new FormData();
        fd.append('action', 'edit_handle');
        fd.append('auth', formData.auth);
        fd.append('collageid', collageId);
        fd.append('category', formData.category);
        fd.append('description', newDescription);
        fd.append('tags', formData.tags);
        if (formData.reverseChecked) fd.append('reverseorder', 'on');
        GM_xmlhttpRequest({
            method: 'POST',
            url: 'collages.php',
            data: fd,
            timeout: 20000,
            onload: function(resp) {
                if (resp.status >= 200 && resp.status < 400) cb(true);
                else cb(false, 'HTTP ' + resp.status);
            },
            onerror: function() { cb(false, 'network error'); },
        });
    }

    // Finds every embedded image in a collage's description that's on a known
    // rehostable/geo-restricted host (imgur, pixhost, etc. — same domain list used
    // for torrent-group description images), rehosts each to RED, and swaps the URLs
    // in-place. Geoblocking in particular is host-side (imgur blocks certain regions
    // outright), so a viewer in an affected region just sees a broken image no matter
    // how the link is formatted — moving it to RED's own host fixes that for everyone.
    // Returns a plain result object rather than touching the DOM, so both the
    // single-collage button and the multi-collage batch runner below can share it.
    async function processCollageDescriptionImages(collageId, apiKey, onProgress) {
        const report = (msg) => { if (onProgress) onProgress(msg); };

        report('Fetching collage description…');
        const formData = await new Promise(res => fetchCollageEditFormData(collageId, res));
        if (!formData || !formData.auth) {
            return { collageId, ok: false, uploaded: 0, msg: 'Could not load the collage edit form / auth token.' };
        }

        const imgUrls = [...new Set(extractBBCodeImgUrls(formData.description).filter(needsDescriptionRehost))];
        if (imgUrls.length === 0) {
            return { collageId, ok: true, uploaded: 0, msg: 'No rehostable description images found.' };
        }

        report(`Found ${imgUrls.length} rehostable description image(s) — uploading…`);
        let updatedDescription = formData.description;
        let uploaded = 0, failed = 0;
        const deadBandcampUrls = [];
        for (const oldUrl of imgUrls) {
            report(`Uploading ${uploaded + failed + 1} of ${imgUrls.length}…`);
            const newUrl = await batchUploadImage(oldUrl, apiKey);
            if (newUrl) {
                updatedDescription = updatedDescription.split(oldUrl).join(newUrl);
                uploaded++;
            } else {
                failed++;
                if (isBandcampImageUrl(oldUrl)) deadBandcampUrls.push(oldUrl);
            }
        }
        // A dead bcbits/Bandcamp cover with an explicit bandcamp.com link ELSEWHERE in
        // the same description isn't a guess — the description itself already names the
        // correct page — so that resolves automatically, same as any other easy fix.
        // Only genuinely source-less dead covers (no link anywhere) fall through to the
        // manual review picker.
        let autoFixedCount = 0;
        if (deadBandcampUrls.length > 0) {
            const explicitLink = extractBandcampLinkFromText(formData.description);
            if (explicitLink) {
                report('Found a Bandcamp link in the description — fetching current label art…');
                const bio = await fetchBandcampBioImage(explicitLink);
                if (bio && bio.artUrl) {
                    const rehosted = await batchUploadImage(bio.artUrl, apiKey);
                    if (rehosted) {
                        deadBandcampUrls.forEach(u => { updatedDescription = updatedDescription.split(u).join(rehosted); });
                        autoFixedCount = deadBandcampUrls.length;
                        uploaded += autoFixedCount;
                        failed -= autoFixedCount;
                        deadBandcampUrls.length = 0;
                    }
                }
            }
        }

        if (uploaded === 0) {
            if (failed === deadBandcampUrls.length && deadBandcampUrls.length > 0) {
                // Every failure here is a dead Bandcamp cover with nothing else in the
                // description to recover it from — auto-fixing would mean guessing at a
                // replacement via search, which is exactly the error-prone approach we're
                // avoiding. Treat the scan as complete (so it's not retried forever) and
                // surface it separately for a manual look instead.
                return { collageId, ok: true, uploaded: 0, deadBandcampUrls, msg: `${deadBandcampUrls.length} dead Bandcamp cover(s) — no live source to auto-fix, flagged for review.` };
            }
            return { collageId, ok: false, uploaded: 0, deadBandcampUrls, msg: `Found ${imgUrls.length} image(s) but none could be uploaded (${failed} failed).` };
        }

        report('Saving updated description…');
        const saved = await new Promise(res => submitCollageDescription(collageId, updatedDescription, formData, (ok, err) => res({ ok, err })));
        if (!saved.ok) {
            return { collageId, ok: false, uploaded: 0, deadBandcampUrls, msg: `Rehosted ${uploaded} image(s) but saving the description failed${saved.err ? ' (' + saved.err + ')' : ''}.` };
        }
        const autoNote = autoFixedCount > 0 ? `, ${autoFixedCount} via a linked Bandcamp page` : '';
        return {
            collageId, ok: true, uploaded, deadBandcampUrls,
            msg: `Rehosted ${uploaded} description image(s)${autoNote}${failed ? ` (${failed} failed${deadBandcampUrls.length ? `, ${deadBandcampUrls.length} dead Bandcamp` : ''})` : ''} and saved.`,
        };
    }

    // Bandcamp label pages consistently expose their current bio picture at a fixed
    // spot in the page's own HTML — confirmed live: #bio-container img. That <img> tag
    // itself is only a small thumbnail (e.g. "..._21.jpg") — the actual larger image
    // lives on the href of the ".popupImage" <a> wrapping it (e.g. "..._10.jpg",
    // confirmed live on dugupthebongo.bandcamp.com). Prefer that href; fall back to the
    // img's own src only if there's no wrapping popup-image anchor.
    function fetchBandcampBioImage(bandUrl) {
        return new Promise((resolve) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: bandUrl,
                timeout: 15000,
                onload: function(r) {
                    try {
                        const doc = new DOMParser().parseFromString(r.responseText, 'text/html');
                        const bioImg = doc.querySelector('#bio-container img, .popupImage img, a.popupImage img');
                        const popupAnchor = bioImg ? bioImg.closest('a.popupImage, a') : null;
                        // getAttribute (not .href) — documents from DOMParser don't reliably
                        // resolve relative URLs against bandUrl, and bcbits.com hrefs are
                        // always absolute anyway, so raw attribute value is safest here.
                        const hrefAttr = popupAnchor ? popupAnchor.getAttribute('href') : null;
                        const artUrl = (hrefAttr && /^https?:\/\//i.test(hrefAttr)) ? hrefAttr : ((bioImg && bioImg.src) ? bioImg.src : null);
                        resolve({ bandcampUrl: bandUrl, artUrl });
                    } catch(e) { resolve({ bandcampUrl: bandUrl, artUrl: null }); }
                },
                onerror:   () => resolve({ bandcampUrl: bandUrl, artUrl: null }),
                ontimeout: () => resolve({ bandcampUrl: bandUrl, artUrl: null }),
            });
        });
    }

    // A bandcamp.com URL already present elsewhere in the same description (a link to
    // the label's page or one of its releases) isn't a guess — it directly names the
    // right source — unlike a name-based /search lookup. Matches on the "bandcamp.com"
    // substring so it naturally excludes bcbits.com image URLs (different domain).
    function extractBandcampLinkFromText(text) {
        if (!text) return null;
        const m = text.match(/https?:\/\/[a-z0-9.-]*bandcamp\.com[^\s\[\]()"']*/i);
        if (!m) return null;
        try { return new URL(m[0]).origin + '/'; } catch(e) { return null; }
    }

    // Resolving a label NAME to its current art happens in two hops: (1) Bandcamp's own
    // /search page to find the label's subdomain, preferring an ARTIST/BAND-type result
    // over ALBUM/TRACK hits since those point at the label's own page rather than a
    // specific release; (2) fetchBandcampBioImage() for the art itself. Best-effort only
    // — this is a human-reviewed suggestion, never applied automatically (unlike
    // extractBandcampLinkFromText's case, this one is a guess).
    function searchBandcampLabelArt(name) {
        return new Promise((resolve) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: 'https://bandcamp.com/search?q=' + encodeURIComponent(name),
                timeout: 15000,
                onload: function(r) {
                    try {
                        const doc = new DOMParser().parseFromString(r.responseText, 'text/html');
                        const items = [...doc.querySelectorAll('.result-items li, .searchresult')];
                        const best = items.find(li => {
                            const type = li.querySelector('.itemtype, .subhead');
                            return type && /artist|band/i.test(type.textContent);
                        }) || items[0];
                        const a = best ? best.querySelector('a.heading, a') : null;
                        if (!a || !a.href) { resolve(null); return; }
                        let bandUrl;
                        try { bandUrl = new URL(a.href).origin + '/'; } catch(e) { resolve(null); return; }
                        fetchBandcampBioImage(bandUrl).then(resolve);
                    } catch(e) { resolve(null); }
                },
                onerror:   () => resolve(null),
                ontimeout: () => resolve(null),
            });
        });
    }

    // Applies a manually-approved Bandcamp art URL to a collage's description, replacing
    // whichever dead bcbits/bandcamp URL(s) are currently in it. Re-fetches the live
    // description first (rather than reusing anything cached from the earlier scan) so
    // this is safe to click even if the description changed in the meantime.
    async function applyBandcampArtToCollage(collageId, newArtSourceUrl, apiKey) {
        const formData = await new Promise(res => fetchCollageEditFormData(collageId, res));
        if (!formData || !formData.auth) return { ok: false, msg: 'Could not reload the collage edit form.' };

        const deadUrls = [...new Set(extractBBCodeImgUrls(formData.description).filter(isBandcampImageUrl))];
        if (deadUrls.length === 0) return { ok: false, msg: 'No Bandcamp cover URL found in the description anymore (already changed?).' };

        const uploadedUrl = await batchUploadImage(newArtSourceUrl, apiKey);
        if (!uploadedUrl) return { ok: false, msg: "Found the label's art but couldn't rehost it." };

        let updatedDescription = formData.description;
        deadUrls.forEach(u => { updatedDescription = updatedDescription.split(u).join(uploadedUrl); });

        const saved = await new Promise(res => submitCollageDescription(collageId, updatedDescription, formData, (ok, err) => res({ ok, err })));
        return saved.ok
            ? { ok: true, msg: `Replaced ${deadUrls.length} dead cover(s) with the label's current Bandcamp art.` }
            : { ok: false, msg: `Uploaded but saving the description failed${saved.err ? ' (' + saved.err + ')' : ''}.` };
    }

    // Thin wrapper for the single-collage "🖼 Fix Description Images" button — same
    // core, just streams progress into that panel's status line as plain text.
    async function fixCollageDescriptionImages(collageId, apiKey, statusEl) {
        const result = await processCollageDescriptionImages(collageId, apiKey, (msg) => { statusEl.textContent = msg; });
        statusEl.textContent = (result.ok ? '✓ ' : '✗ ') + result.msg;
    }

    function setupSingleCollageBatchPanel() {
        // Only on a specific collage page — collages.php?id=X is the standard URL, but
        // RED also serves the exact same page under the singular collage.php?id=X (an
        // older/alternate spelling that still resolves — confirmed live: it redirects to
        // login like any real auth-gated page, unlike a genuinely nonexistent path which
        // 404s). Accept either spelling so the panel doesn't silently fail to appear.
        const collageIdMatch = window.location.search.match(/[?&]id=(\d+)/);
        if (!collageIdMatch || !/collages?\.php/.test(window.location.pathname)) return;

        const apiKey = getRedApiKey();
        if (!apiKey) return;

        const collageId = collageIdMatch[1];

        const panel = document.createElement('div');
        panel.id = 'coverup-batch-panel';
        panel.style.cssText = 'background:#1a1a1a;border:2px solid #4CAF50;border-radius:10px;padding:20px;margin:16px 0;font-family:sans-serif;color:#fff;';
        panel.innerHTML = `
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">
                <div style="font-size:16px;font-weight:bold;color:#4CAF50;">🔴 CoverUp — Batch Rehost This Collage</div>
                <div style="display:flex;align-items:center;gap:8px;">
                    <a href="https://redacted.sh/random.php?action=collage" title="Jump to a random collage" style="padding:9px 14px;background:#333;color:#ccc;border-radius:6px;font-weight:bold;font-size:14px;text-decoration:none;white-space:nowrap;">🎲 Random Collage</a>
                    <button id="batch-fix-desc-imgs" title="Rehost geoblocked/rehostable images (e.g. imgur) found in this collage's own description" style="padding:9px 14px;background:#333;color:#ccc;border:none;border-radius:6px;cursor:pointer;font-weight:bold;font-size:14px;white-space:nowrap;">🖼 Fix Description Images</button>
                    <button id="batch-start" style="padding:9px 22px;background:#4CAF50;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:bold;font-size:14px;">Scan covers</button>
                    <button id="batch-stop" style="display:none;padding:9px 18px;background:#555;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:bold;font-size:14px;">Stop</button>
                    <button id="batch-panel-toggle" title="Hide the whole batch panel" style="padding:9px 18px;background:#555;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:bold;font-size:14px;flex-shrink:0;">Hide</button>
                </div>
            </div>
            <div id="batch-panel-body">
            <div style="background:#450a0a;border:1px solid #ef4444;border-radius:6px;padding:10px 12px;margin-bottom:10px;font-size:12px;color:#fca5a5;">
                <strong>⚠ Use at your own risk.</strong> Batch mode automatically updates torrent group metadata.
                Test with a small number first and check results manually.
            </div>
            <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:10px;">
                <div id="batch-status" style="font-size:13px;color:#aaa;flex:1;">
                    Checks all releases in this collage for covers that need rehosting to RED's image host.
                </div>
                <span id="batch-found-count" style="font-size:12px;color:#4CAF50;font-weight:bold;white-space:nowrap;">0 found so far</span>
            </div>
            ${renderBatchRunModeSelector()}
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;font-size:12px;color:#666;">
                <span id="batch-processed-count"></span>
                <a href="javascript:void(0)" id="batch-reset-page-processed" style="color:#555;text-decoration:underline;">Reset progress for this collage only</a>
                <a href="javascript:void(0)" id="batch-reset-processed" style="color:#555;text-decoration:underline;">Reset all progress</a>
            </div>
            <div id="batch-progress-bar-wrap" style="display:none;background:#333;border-radius:4px;height:8px;margin-bottom:12px;">
                <div id="batch-progress-bar" style="background:#4CAF50;height:8px;border-radius:4px;width:0%;transition:width 0.3s;"></div>
            </div>
            <div id="batch-results" style="display:none;max-height:400px;overflow-y:auto;border:1px solid #333;border-radius:6px;"></div>
            </div>`;

        const target = document.querySelector('.thin') || document.querySelector('#content');
        console.log('[CoverUp] collage panel target:', target, 'collageId:', collageId, 'hasKey:', !!apiKey);
        if (target) target.prepend(panel);
        else document.body.prepend(panel);

        setupBatchPanelCollapse(panel);
        wireBatchRunModeSelector(panel);
        refreshProcessedCountDisplay();

        panel.querySelector('#batch-reset-page-processed').onclick = async () => {
            if (!confirm('Re-check every group in this collage from scratch? Groups already confirmed fine or rehosted elsewhere are unaffected.')) return;
            const link = panel.querySelector('#batch-reset-page-processed');
            const prevText = link.textContent;
            link.textContent = 'Fetching list…';
            const colData = await apiGet(`ajax.php?action=collage&id=${collageId}&showonlygroups=1`, apiKey);
            const ids = (colData && colData.status === 'success' && colData.response.torrentGroupIDList) || [];
            const affected = removeGroupsFromProgress(ids);
            link.textContent = prevText;
            refreshProcessedCountDisplay();
            alert(`Cleared ${affected} group(s) in this collage — they'll be re-checked on the next scan.`);
        };

        panel.querySelector('#batch-reset-processed').onclick = () => {
            if (confirm('Clear saved scan progress? All groups will be checked again from scratch next run.\n\n(Your all-time rehosted count is not affected.)')) {
                clearProcessedGroups();
                clearScannedGroups();
                clearFastScannedGroups();
                refreshProcessedCountDisplay();
            }
        };

        const startBtn     = panel.querySelector('#batch-start');
        const stopBtn      = panel.querySelector('#batch-stop');
        const statusEl     = panel.querySelector('#batch-status');
        const foundCountEl = panel.querySelector('#batch-found-count');
        const progressWrap = panel.querySelector('#batch-progress-bar-wrap');
        const progressBar  = panel.querySelector('#batch-progress-bar');
        const resultsEl    = panel.querySelector('#batch-results');

        panel.querySelector('#batch-fix-desc-imgs').onclick = async () => {
            const btn = panel.querySelector('#batch-fix-desc-imgs');
            btn.disabled = true;
            try {
                await fixCollageDescriptionImages(collageId, apiKey, statusEl);
            } finally {
                btn.disabled = false;
            }
        };

        stopBtn.onclick = () => {
            batchStopRequested = true;
            stopBtn.disabled = true;
            stopBtn.textContent = 'Stopping…';
        };

        startBtn.onclick = doScan;

        async function doScan() {
            console.log('[CoverUp] scan button clicked');
            const { limit, ptpimgOnlyMode } = getBatchRunMode(panel);

            batchStopRequested = false;
            startBtn.disabled = true;
            startBtn.textContent = 'Scanning…';
            stopBtn.style.display = 'inline-block';
            stopBtn.disabled = false;
            stopBtn.textContent = 'Stop';
            progressWrap.style.display = 'block';
            resultsEl.style.display = 'block';
            resultsEl.innerHTML = '';
            foundCountEl.textContent = '0 found so far';

            statusEl.textContent = 'Fetching collage group list…';
            console.log('[CoverUp] fetching collage', collageId);
            const colData = await apiGet(`ajax.php?action=collage&id=${collageId}&showonlygroups=1`, apiKey);
            console.log('[CoverUp] collage data:', colData ? colData.status : 'null');
            if (!colData || colData.status !== 'success') {
                statusEl.textContent = 'Failed to fetch collage data.';
                startBtn.disabled = false; startBtn.textContent = 'Scan covers';
                stopBtn.style.display = 'none';
                return;
            }
            // torrentGroupIDList is the complete, unpaginated list of every group in the
            // collage — seed every group as "unknown" (falls back to a per-group fetch,
            // exactly like before this optimization existed) so large collages never
            // silently lose groups beyond page 1. The enriched torrentgroups array
            // (wikiImage/name/musicInfo/year) is paginated at ~50/page — only page 1's
            // data is free (it comes back on this same call), so that's all we use here.
            // Deliberately NOT paging through the rest: for a large collage that would
            // just tack extra API calls onto the per-group scan instead of replacing it.
            const groupInfo = new Map();
            (colData.response.torrentGroupIDList || []).forEach(gid => {
                groupInfo.set(String(gid), { wikiImage: null, name: String(gid), year: '', artist: '' });
            });
            const page1List = colData.response.torrentgroups;
            if (Array.isArray(page1List)) {
                page1List.forEach(g => {
                    const gid = g.id ?? g.groupId ?? null;
                    if (gid != null) groupInfo.set(String(gid), {
                        wikiImage: (g.wikiImage || '').trim(),
                        name: g.name || String(gid),
                        year: g.year || '',
                        artist: (g.musicInfo && g.musicInfo.artists && g.musicInfo.artists[0]) ? g.musicInfo.artists[0].name : '',
                    });
                });
            }
            const allGroupIds = [...groupInfo.keys()];

            const processedGroups   = getProcessedGroups();
            const scannedGroups     = getScannedGroups();
            const fastScannedGroups = getFastScannedGroups();
            const unseenGroupIds = allGroupIds.filter(g => {
                const key = String(g);
                if (processedGroups.has(key) || scannedGroups.has(key)) return false;
                if (ptpimgOnlyMode && fastScannedGroups.has(key)) return false;
                return true;
            });
            const groupIds = [...unseenGroupIds].sort(() => Math.random() - 0.5);

            statusEl.textContent = `Found ${allGroupIds.length} groups in this collage (${groupIds.length} not yet checked). Checking covers…`;

            const toRehost = [];
            const skipped  = { ptpimg: 0, alreadyRed: 0, noImage: 0 };
            const scannedThisRun     = [];
            const fastScannedThisRun = [];
            let scanned = 0;
            const scanLimit = limit < Infinity ? Math.min(limit * 10, groupIds.length) : groupIds.length;

            for (let i = 0; i < scanLimit; i++) {
                if (batchStopRequested) break;
                if (limit < Infinity && toRehost.length >= limit) break;
                const gid = groupIds[i];
                scanned++;
                progressBar.style.width = `${Math.round((scanned / scanLimit) * 50)}%`;
                statusEl.textContent = `Checking group ${scanned} of ${scanLimit}…`;
                foundCountEl.textContent = `${toRehost.length} found so far`;

                // Cover host (and artist/year for the streaming-search fallback) are
                // already known from the bulk collage fetch — classify for free, with
                // zero API calls, before ever touching torrentgroup.
                const info       = groupInfo.get(String(gid));
                const knownImage = info && info.wikiImage !== null ? info.wikiImage : undefined;
                const name       = (info && info.name) || gid;
                const year       = (info && info.year) || '';
                const artist     = (info && info.artist) || '';

                let coverNeedsRehost = false;
                let queuedForRehost  = false;
                // Fast Mode only ever performs a shallow, partial check (ptpimg cache
                // only) — when it gives up on a group for that reason, that's not a real
                // verdict, so the group must stay eligible for a later Deep Mode run.
                let shallowSkip = false;
                let imageUrl = knownImage || '';

                if (knownImage !== undefined) {
                    if (!knownImage) {
                        skipped.noImage++;
                    } else {
                        const h = (() => { try { return new URL(knownImage).hostname.toLowerCase(); } catch(e) { return ''; } })();
                        if (ptpimgOnlyMode && !h.includes('ptpimg.me')) {
                            // ptpimg-only mode: ignore every other category for speed —
                            // don't mark scanned, since we never actually evaluated it.
                            shallowSkip = true;
                        } else if (h.includes('redacted.sh') || h.includes('images.redacted.sh')) {
                            if (isRedThumbnailUrl(knownImage)) {
                                toRehost.push({ gid, imageUrl: null, alreadyHosted: upgradeRedThumbnailUrl(knownImage), descImgUrls: [], bbBody: null, name });
                                queuedForRehost = true;
                            } else {
                                skipped.alreadyRed++;
                            }
                        } else if (h.includes('ptpimg.me')) {
                            console.log('[CoverUp] ptpimg detected for gid:', gid, 'trying RED cache…');
                            statusEl.textContent = `Checking group ${scanned} of ${scanLimit} — ptpimg, trying RED cache…`;
                            const recoveredUrl = await uploadUrlToRed(knownImage, apiKey);
                            if (recoveredUrl) {
                                toRehost.push({ gid, imageUrl: null, alreadyHosted: recoveredUrl, descImgUrls: [], bbBody: null, name });
                                queuedForRehost = true;
                            } else if (ptpimgOnlyMode) {
                                // Fast mode: no cache hit means give up immediately — this
                                // is a shallow check, so don't mark scanned.
                                skipped.ptpimg++;
                                shallowSkip = true;
                            } else {
                                statusEl.textContent = `Checking group ${scanned} of ${scanLimit} — checking source links…`;
                                const sourceImageUrl = await new Promise(res => fetchGroupPageAndResolveImage(gid, '', res));
                                console.log('[CoverUp] source image resolved:', sourceImageUrl);
                                if (sourceImageUrl) {
                                    toRehost.push({ gid, imageUrl: sourceImageUrl, descImgUrls: [], bbBody: null, name, viaSources: true });
                                    queuedForRehost = true;
                                } else {
                                    // No embedded links — try streaming search, queue for approval
                                    statusEl.textContent = `Checking group ${scanned} of ${scanLimit} — searching streaming sources…`;
                                    const albumInfo = { artist, album: name, year: String(year) };
                                    const candidates = await new Promise(res => searchStreamingForApproval(albumInfo, res));
                                    if (candidates && candidates.length > 0) {
                                        toRehost.push({ gid, imageUrl: null, descImgUrls: [], bbBody: null, name, needsApproval: true, candidates, albumInfo });
                                        queuedForRehost = true;
                                    } else {
                                        skipped.ptpimg++;
                                    }
                                }
                            }
                        } else if (!ptpimgOnlyMode && needsBatchRehost(knownImage)) {
                            coverNeedsRehost = true;
                        }
                    }
                }

                // Only groups whose cover actually needs rehosting (or whose cover status
                // is still unknown, per the rare fallback above) pay for the extra
                // torrentgroup API call. Confirmed clean-cover groups never reach here —
                // that's the speedup.
                if (!queuedForRehost && (coverNeedsRehost || knownImage === undefined)) {
                    const groupData = await apiGet(`ajax.php?action=torrentgroup&id=${gid}`, apiKey);
                    if (!groupData || groupData.status !== 'success') continue;
                    const group  = groupData.response.group;
                    const bbBody = group.bbBody || group.wikiBody || '';
                    if (knownImage === undefined) {
                        // Redo the classification now that we actually have the real wikiImage.
                        imageUrl = (group.wikiImage || '').trim();
                        const gname   = group.name || name;
                        const gyear   = group.year || year;
                        const gartist = (group.musicInfo && group.musicInfo.artists && group.musicInfo.artists[0]) ? group.musicInfo.artists[0].name : artist;
                        if (!imageUrl) { skipped.noImage++; }
                        else {
                            const h = (() => { try { return new URL(imageUrl).hostname.toLowerCase(); } catch(e) { return ''; } })();
                            if (ptpimgOnlyMode && !h.includes('ptpimg.me')) {
                                // ptpimg-only mode: ignore every other category for speed —
                                // don't mark scanned, since we never actually evaluated it.
                                shallowSkip = true;
                            } else if (h.includes('redacted.sh') || h.includes('images.redacted.sh')) {
                                if (isRedThumbnailUrl(imageUrl)) {
                                    toRehost.push({ gid, imageUrl: null, alreadyHosted: upgradeRedThumbnailUrl(imageUrl), descImgUrls: [], bbBody: null, name: gname });
                                    queuedForRehost = true;
                                } else {
                                    skipped.alreadyRed++;
                                }
                            }
                            else if (h.includes('ptpimg.me')) {
                                const recoveredUrl = await uploadUrlToRed(imageUrl, apiKey);
                                if (recoveredUrl) {
                                    toRehost.push({ gid, imageUrl: null, alreadyHosted: recoveredUrl, descImgUrls: [], bbBody: null, name: gname });
                                    queuedForRehost = true;
                                } else if (ptpimgOnlyMode) {
                                    // Shallow check (cache only) — don't mark scanned.
                                    skipped.ptpimg++;
                                    shallowSkip = true;
                                } else {
                                    const sourceImageUrl = await new Promise(res => fetchGroupPageAndResolveImage(gid, bbBody, res));
                                    if (sourceImageUrl) {
                                        toRehost.push({ gid, imageUrl: sourceImageUrl, descImgUrls: [], bbBody: null, name: gname, viaSources: true });
                                        queuedForRehost = true;
                                    } else {
                                        const albumInfo = { artist: gartist, album: gname, year: String(gyear) };
                                        const candidates = await new Promise(res => searchStreamingForApproval(albumInfo, res));
                                        if (candidates && candidates.length > 0) {
                                            toRehost.push({ gid, imageUrl: null, descImgUrls: [], bbBody: null, name: gname, needsApproval: true, candidates, albumInfo });
                                            queuedForRehost = true;
                                        } else { skipped.ptpimg++; }
                                    }
                                }
                            } else if (!ptpimgOnlyMode && needsBatchRehost(imageUrl)) { coverNeedsRehost = true; }
                        }
                    }
                    if (!ptpimgOnlyMode && !queuedForRehost && coverNeedsRehost) {
                        const descImgUrls = extractBBCodeImgUrls(bbBody).filter(needsDescriptionRehost);
                        toRehost.push({ gid, imageUrl, descImgUrls, bbBody: descImgUrls.length > 0 ? bbBody : null, name: group.name || name });
                        queuedForRehost = true;
                    }
                }

                if (!queuedForRehost) {
                    if (shallowSkip) {
                        fastScannedThisRun.push(gid);
                    } else {
                        scannedThisRun.push(gid);
                    }
                }
            }

            addScannedGroups(scannedThisRun);
            addFastScannedGroups(fastScannedThisRun);

            const stoppedDuringScan = batchStopRequested;
            stopBtn.style.display = 'none';

            const toRehostFinal = toRehost.slice(0, limit);
            statusEl.textContent = `Found ${toRehost.length} eligible (rehosting ${toRehostFinal.length}). ${skipped.ptpimg} ptpimg, ${skipped.alreadyRed} already on RED, ${skipped.noImage} no image.${stoppedDuringScan ? ' Stopped early.' : ''}`;
            foundCountEl.textContent = `${toRehost.length} found so far`;

            if (toRehostFinal.length === 0) {
                progressBar.style.width = '100%';
                startBtn.disabled = false; startBtn.textContent = 'Scan again';
                startBtn.onclick = doScan;
                refreshProcessedCountDisplay();
                return;
            }

            resultsEl.innerHTML = toRehostFinal.map((item, idx) => {
                if (item.needsApproval) {
                    const thumbs = item.candidates.map((c, ci) =>
                        `<div style="display:inline-block;margin:4px;text-align:center;vertical-align:top;width:100px;">
                            <img src="${escHtml(c.imageUrl)}" style="width:100px;height:100px;object-fit:contain;background:#111;border-radius:4px;border:2px solid #333;cursor:pointer;" data-idx="${idx}" data-ci="${ci}" class="approval-thumb">
                            <div style="font-size:9px;color:#666;margin-top:2px;">${escHtml(c.searchSource)}</div>
                            <button class="approval-btn" data-idx="${idx}" data-ci="${ci}" style="margin-top:3px;padding:3px 8px;background:#4CAF50;color:#fff;border:none;border-radius:3px;cursor:pointer;font-size:10px;">✓ Use</button>
                        </div>`
                    ).join('');
                    const artistName = item.albumInfo && item.albumInfo.artist ? item.albumInfo.artist : '';
                    return `<div id="batch-row-${idx}" style="padding:10px 12px;border-bottom:1px solid #222;font-size:12px;">
                        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
                            <a href="/torrents.php?id=${item.gid}" target="_blank" style="color:#4CAF50;text-decoration:none;font-weight:bold;">${artistName ? escHtml(artistName) + ' — ' : ''}${escHtml(item.name)}</a>
                            <span style="display:flex;align-items:center;gap:6px;">
                                <span id="batch-status-${idx}" style="white-space:nowrap;color:#f59e0b;font-size:11px;">awaiting approval</span>
                                <button class="approval-skip" data-idx="${idx}" style="padding:3px 8px;background:#333;color:#aaa;border:none;border-radius:3px;cursor:pointer;font-size:10px;">✗ Skip</button>
                            </span>
                        </div>
                        <div style="font-size:10px;color:#666;margin-bottom:6px;">No embedded links found — streaming search results (${item.candidates.length} candidates):</div>
                        <div>${thumbs}</div>
                    </div>`;
                }
                const parts = [];
                if (item.imageUrl) parts.push(`cover: ${escHtml(item.imageUrl)}`);
                if (item.alreadyHosted) parts.push(`cover: ${escHtml(item.alreadyHosted)} (recovered from RED cache)`);
                if (item.descImgUrls && item.descImgUrls.length) parts.push(`${item.descImgUrls.length} desc image(s)`);
                return `<div style="display:flex;align-items:center;gap:10px;padding:8px 12px;border-bottom:1px solid #222;font-size:12px;">
                    <div style="flex:1;min-width:0;">
                        <a href="/torrents.php?id=${item.gid}" target="_blank" style="color:#4CAF50;text-decoration:none;">${escHtml(item.name)}</a>
                        <div style="color:#666;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${parts.join(' · ')}</div>
                    </div>
                    <span id="batch-status-${idx}" style="white-space:nowrap;color:#888;">queued</span>
                </div>`;
            }).join('');

            // Wire up approval buttons
            resultsEl.querySelectorAll('.approval-btn').forEach(btn => {
                btn.onclick = () => {
                    const idx = parseInt(btn.dataset.idx);
                    const ci  = parseInt(btn.dataset.ci);
                    const item = toRehostFinal[idx];
                    item.imageUrl = item.candidates[ci].imageUrl;
                    item.approved = true;
                    const row = document.getElementById(`batch-row-${idx}`);
                    const statusEl2 = document.getElementById(`batch-status-${idx}`);
                    statusEl2.textContent = 'approved — queued';
                    statusEl2.style.color = '#4CAF50';
                    // Highlight selected thumb, dim others
                    row.querySelectorAll('.approval-thumb').forEach((t, ti) => {
                        t.style.borderColor = ti === ci ? '#4CAF50' : '#222';
                        t.style.opacity = ti === ci ? '1' : '0.4';
                    });
                    row.querySelectorAll('.approval-btn').forEach(b => b.style.display = 'none');
                    row.querySelector('.approval-skip').style.display = 'none';
                };
            });
            resultsEl.querySelectorAll('.approval-skip').forEach(btn => {
                btn.onclick = () => {
                    const idx = parseInt(btn.dataset.idx);
                    toRehostFinal[idx].skipped = true;
                    const statusEl2 = document.getElementById(`batch-status-${idx}`);
                    statusEl2.textContent = 'skipped';
                    statusEl2.style.color = '#555';
                };
            });

            const hasApprovalItems = toRehostFinal.some(i => i.needsApproval);
            startBtn.disabled = false;
            startBtn.textContent = hasApprovalItems ? 'Done — Start Rehosting (approve thumbnails below first)' : 'Done — Start Rehosting';
            startBtn.onclick = doRehost;

            async function doRehost() {
                batchStopRequested = false;
                startBtn.disabled = true; startBtn.textContent = 'Rehosting…';
                stopBtn.style.display = 'inline-block'; stopBtn.disabled = false; stopBtn.textContent = 'Stop';

                let done = 0;
                for (let i = 0; i < toRehostFinal.length; i++) {
                    if (batchStopRequested) break;
                    const item = toRehostFinal[i];
                    if (item.skipped) continue;
                    if (item.needsApproval && !item.approved) continue; // skip unapproved
                    const { gid, imageUrl, alreadyHosted, descImgUrls, bbBody, name } = item;
                    const rowStatus = document.getElementById(`batch-status-${i}`);
                    rowStatus.textContent = 'uploading…'; rowStatus.style.color = 'orange';
                    progressBar.style.width = `${Math.round(50 + (i / toRehostFinal.length) * 50)}%`;
                    statusEl.textContent = `Rehosting ${i + 1} of ${toRehostFinal.length}: ${name}`;

                    try {
                        let postParams = []; let anyFailed = false;
                        if (alreadyHosted) {
                            postParams.push(`image=${encodeURIComponent(alreadyHosted)}`);
                        } else if (imageUrl) {
                            const newUrl = await batchUploadWithDeadSourceFallback(imageUrl, gid, apiKey);
                            if (newUrl) { postParams.push(`image=${encodeURIComponent(newUrl)}`); } else { anyFailed = true; }
                        }
                        if (descImgUrls && descImgUrls.length && bbBody) {
                            let updatedBody = bbBody;
                            for (const oldImgUrl of descImgUrls) {
                                const newImgUrl = await batchUploadImage(oldImgUrl, apiKey);
                                if (newImgUrl) { updatedBody = updatedBody.split(oldImgUrl).join(newImgUrl); } else { anyFailed = true; }
                            }
                            if (updatedBody !== bbBody) postParams.push(`body=${encodeURIComponent(updatedBody)}`);
                        }
                        if (postParams.length > 0) {
                            postParams.push(`summary=${encodeURIComponent('Cover rehosted to RED image host via CoverUp')}`);
                            await apiPost(`ajax.php?action=groupedit&id=${gid}`, apiKey, postParams.join('&'));
                            rowStatus.textContent = anyFailed ? '⚠ partial' : '✓ rehosted';
                            rowStatus.style.color  = anyFailed ? '#f59e0b' : '#4CAF50';
                            if (!anyFailed) { done++; addProcessedGroup(gid); }
                        } else {
                            rowStatus.textContent = '✗ upload failed'; rowStatus.style.color = '#ff4444';
                        }
                    } catch(e) { rowStatus.textContent = '✗ error'; rowStatus.style.color = '#ff4444'; }
                }

                progressBar.style.width = '100%';
                statusEl.textContent = `Done! ${done} rehosted.${batchStopRequested ? ' Stopped early.' : ''}`;
                startBtn.disabled = false; startBtn.textContent = 'Scan again';
                startBtn.onclick = doScan;
                stopBtn.style.display = 'none';
                refreshProcessedCountDisplay();
            }
        }
    }

    // ============================================================
    // --- MISSING ARTWORK BATCH (better.php?method=artwork) ---
    // ============================================================
    // RED's own "better.php" lists torrent groups with a known quality issue — one of
    // those lists (method=artwork) is releases with NO cover art at all. Unlike every
    // other batch panel here, this isn't a JSON API: better.php is a plain paginated
    // HTML list (50 rows/page), so it's scraped instead. Conveniently, each row is
    // already "<a artist.php>Artist</a> - <a torrents.php?id=X>Album</a>", which gives
    // us the exact artist/album strings the streaming-search fallback needs for free —
    // no extra per-group API call just to find out what to search for.
    function fetchBetterArtworkPage(page) {
        return new Promise((resolve) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: `https://redacted.sh/better.php?page=${page}&method=artwork`,
                timeout: 20000,
                onload: function(r) {
                    try {
                        const doc = new DOMParser().parseFromString(r.responseText, 'text/html');
                        const countMatch = doc.body.textContent.match(/There are ([\d,]+) torrent groups remaining/);
                        const totalCount = countMatch ? parseInt(countMatch[1].replace(/,/g, ''), 10) : null;
                        const rows = [];
                        doc.querySelectorAll('tr.torrent_row').forEach(tr => {
                            const artistA = tr.querySelector('a[href*="artist.php"]');
                            const albumA  = tr.querySelector('a[href*="torrents.php"]');
                            if (!albumA) return;
                            let gid = null;
                            try { gid = new URL(albumA.getAttribute('href'), 'https://redacted.sh').searchParams.get('id'); } catch(e) {}
                            if (!gid) return;
                            rows.push({
                                gid,
                                artist: artistA ? artistA.textContent.trim() : '',
                                album:  albumA.textContent.trim(),
                            });
                        });
                        resolve({ rows, totalCount });
                    } catch(e) {
                        console.warn('[CoverUp] fetchBetterArtworkPage: parse error for page', page, e);
                        resolve({ rows: [], totalCount: null });
                    }
                },
                onerror:   () => { console.warn('[CoverUp] fetchBetterArtworkPage: network error for page', page); resolve({ rows: [], totalCount: null }); },
                ontimeout: () => { console.warn('[CoverUp] fetchBetterArtworkPage: timed out fetching page', page); resolve({ rows: [], totalCount: null }); },
            });
        });
    }

    function setupBetterArtworkBatchPanel() {
        // Only on better.php?method=artwork (RED's own "missing artwork" listing)
        if (!/better\.php/.test(window.location.pathname) || !/[?&]method=artwork\b/.test(window.location.search)) return;

        const apiKey = getRedApiKey();
        if (!apiKey) return;

        const suggestedStart = getLastBetterPage();

        const panel = document.createElement('div');
        panel.id = 'coverup-batch-panel';
        panel.style.cssText = 'background:#1a1a1a;border:2px solid #4CAF50;border-radius:10px;padding:20px;margin:16px 0;font-family:sans-serif;color:#fff;';
        panel.innerHTML = `
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">
                <div style="font-size:16px;font-weight:bold;color:#4CAF50;">🔴 CoverUp — Find Missing Artwork</div>
                <div style="display:flex;align-items:center;gap:8px;">
                    <button id="batch-start" style="padding:9px 22px;background:#4CAF50;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:bold;font-size:14px;">Scan pages</button>
                    <button id="batch-stop" style="display:none;padding:9px 18px;background:#555;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:bold;font-size:14px;">Stop</button>
                    <button id="batch-panel-toggle" title="Hide the whole batch panel" style="padding:9px 18px;background:#555;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:bold;font-size:14px;flex-shrink:0;">Hide</button>
                </div>
            </div>
            <div id="batch-panel-body">
            <div style="background:#450a0a;border:1px solid #ef4444;border-radius:6px;padding:10px 12px;margin-bottom:10px;font-size:12px;color:#fca5a5;">
                <strong>⚠ Use at your own risk.</strong> This searches for and adds cover art to releases that currently have none at all — including releases you did not upload.
                Test with a small page range first and check results manually.
            </div>
            <div id="batch-status" style="font-size:13px;color:#aaa;margin-bottom:10px;">
                Scans RED's own "missing artwork" list (thousands of releases, 50 per page) and tries to find cover art for each — embedded description links are used automatically; anything ambiguous falls back to a streaming-source search with a thumbnail picker below.
            </div>
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;font-size:12px;flex-wrap:wrap;">
                <label style="display:flex;align-items:center;gap:5px;color:#aaa;">
                    Start page
                    <input type="number" id="better-start-page" value="${suggestedStart}" min="1"
                        style="width:64px;padding:4px 6px;background:#111;border:1px solid #555;color:#fff;border-radius:4px;font-size:12px;">
                </label>
                <label style="display:flex;align-items:center;gap:5px;color:#aaa;">
                    Pages to scan
                    <input type="number" id="better-page-count" value="3" min="1" max="50"
                        style="width:56px;padding:4px 6px;background:#111;border:1px solid #555;color:#fff;border-radius:4px;font-size:12px;">
                </label>
                <span style="color:#666;">— 50 releases/page. There are thousands of pages, so this remembers where you left off and picks up there next time.</span>
            </div>
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;font-size:12px;">
                <label style="display:flex;align-items:center;gap:5px;color:#aaa;cursor:pointer;">
                    <input type="checkbox" id="batch-test-mode" checked>
                    Test mode — limit to
                    <input type="number" id="batch-test-limit" value="5" min="1" max="50"
                        style="width:52px;padding:4px 6px;background:#111;border:1px solid #555;color:#fff;border-radius:4px;font-size:12px;">
                    found covers
                </label>
            </div>
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;font-size:12px;color:#666;">
                <span id="batch-processed-count"></span>
                <a href="javascript:void(0)" id="batch-reset-processed" style="color:#555;text-decoration:underline;">Reset progress</a>
            </div>
            <div id="batch-progress-bar-wrap" style="display:none;background:#333;border-radius:4px;height:8px;margin-bottom:12px;">
                <div id="batch-progress-bar" style="background:#4CAF50;height:8px;border-radius:4px;width:0%;transition:width 0.3s;"></div>
            </div>
            <div id="batch-found-count" style="font-size:12px;color:#4CAF50;font-weight:bold;margin-bottom:6px;">0 found so far</div>
            <div id="batch-results" style="display:none;max-height:400px;overflow-y:auto;border:1px solid #333;border-radius:6px;"></div>
            </div>`;

        const target = document.querySelector('.thin') || document.querySelector('#content');
        if (target) target.prepend(panel);
        else document.body.prepend(panel);

        setupBatchPanelCollapse(panel);
        refreshProcessedCountDisplay();

        panel.querySelector('#batch-reset-processed').onclick = () => {
            if (confirm('Clear saved scan progress? All groups will be checked again from scratch next run.\n\n(Your all-time rehosted count is not affected. Your saved "start page" position is also unaffected — reset that manually in the field above if you want to rescan from page 1.)')) {
                clearProcessedGroups();
                clearScannedGroups();
                clearFastScannedGroups();
                refreshProcessedCountDisplay();
            }
        };

        panel.querySelector('#batch-stop').onclick = () => {
            batchStopRequested = true;
            const stopBtn = panel.querySelector('#batch-stop');
            stopBtn.disabled = true;
            stopBtn.textContent = 'Stopping…';
        };

        function triggerScan() {
            const startPage = parseInt(panel.querySelector('#better-start-page').value) || 1;
            const pageCount = parseInt(panel.querySelector('#better-page-count').value) || 1;
            const testMode  = panel.querySelector('#batch-test-mode').checked;
            const testLimit = parseInt(panel.querySelector('#batch-test-limit').value) || 5;
            runBetterArtworkBatch(startPage, pageCount, apiKey, testMode ? testLimit : Infinity, panel, refreshProcessedCountDisplay, triggerScan);
        }
        panel.querySelector('#batch-start').onclick = triggerScan;
    }

    async function runBetterArtworkBatch(startPage, pageCount, apiKey, limit, panel, updateProcessedCount, triggerScan) {
        const startBtn     = panel.querySelector('#batch-start');
        const stopBtn      = panel.querySelector('#batch-stop');
        const statusEl     = panel.querySelector('#batch-status');
        const foundCountEl = panel.querySelector('#batch-found-count');
        const progressWrap = panel.querySelector('#batch-progress-bar-wrap');
        const progressBar  = panel.querySelector('#batch-progress-bar');
        const resultsEl    = panel.querySelector('#batch-results');

        batchStopRequested = false;
        startBtn.disabled = true;
        startBtn.textContent = 'Scanning…';
        stopBtn.style.display = 'inline-block';
        stopBtn.disabled = false;
        stopBtn.textContent = 'Stop';
        progressWrap.style.display = 'block';
        resultsEl.style.display = 'block';
        resultsEl.innerHTML = '';
        foundCountEl.textContent = '0 found so far';

        const endPage = startPage + pageCount - 1;
        statusEl.textContent = `Fetching pages ${startPage}–${endPage}…`;

        const processedGroups = getProcessedGroups();
        const scannedGroups   = getScannedGroups();

        let allRows = [];
        let totalCount = null;
        for (let p = startPage; p <= endPage; p++) {
            if (batchStopRequested) break;
            statusEl.textContent = `Fetching page ${p} of ${startPage}–${endPage}…`;
            const { rows, totalCount: tc } = await fetchBetterArtworkPage(p);
            if (tc != null) totalCount = tc;
            if (rows.length === 0) break; // ran past the last page — nothing more to fetch
            allRows = allRows.concat(rows);
            await sleep(400); // light pacing — not API-key-throttled, but no need to hammer it
        }

        setLastBetterPage(endPage + 1);

        const unseenRows = allRows.filter(r => !processedGroups.has(String(r.gid)) && !scannedGroups.has(String(r.gid)));
        statusEl.textContent = `Fetched ${allRows.length} releases from pages ${startPage}–${endPage}${totalCount != null ? ` (${totalCount} total remaining site-wide)` : ''}. ${unseenRows.length} not yet checked. Searching for artwork…`;

        const toRehost = [];
        const scannedThisRun = [];
        let scanned = 0;
        let removed = 0;
        const scanLimit = limit < Infinity ? Math.min(limit * 10, unseenRows.length) : unseenRows.length;

        for (let i = 0; i < scanLimit; i++) {
            if (batchStopRequested) break;
            if (limit < Infinity && toRehost.length >= limit) break;
            const { gid, artist, album } = unseenRows[i];
            scanned++;
            progressBar.style.width = `${Math.round((scanned / scanLimit) * 50)}%`;
            statusEl.textContent = `Checking ${scanned} of ${scanLimit}: ${artist} — ${album}…`;
            foundCountEl.textContent = `${toRehost.length} found so far`;

            // Every group on this list is already confirmed to have no artwork —
            // unlike the other batch panels, there's no existing cover to classify,
            // just a search to run.
            const groupData = await apiGet(`ajax.php?action=torrentgroup&id=${gid}`, apiKey);
            if (!groupData || groupData.status !== 'success' || !groupData.response || !groupData.response.group) {
                // better.php's list can lag behind reality — a group can be deleted,
                // merged, or moved after it was listed there (confirmed live: RED
                // returns {status:"failure", error:"bad id parameter"} for these).
                // Running a full streaming search — or worse, queuing it for approval
                // and sending you to RED's log page when you click through — is wasted
                // effort on a group that no longer exists. Skip it outright.
                removed++;
                scannedThisRun.push(gid);
                continue;
            }
            const bbBody = groupData.response.group.bbBody || groupData.response.group.wikiBody || '';

            let queuedForRehost = false;
            const links = bbBody ? extractSourceLinksFromBBCode(bbBody) : [];
            if (links.length) {
                const sourceImageUrl = await new Promise(res => resolveFirstSourceImage(links, res));
                if (sourceImageUrl) {
                    toRehost.push({ gid, imageUrl: sourceImageUrl, name: `${artist} — ${album}`, viaSources: true });
                    queuedForRehost = true;
                }
            }
            if (!queuedForRehost) {
                statusEl.textContent = `Checking ${scanned} of ${scanLimit}: ${artist} — ${album} — searching streaming sources…`;
                const albumInfo = { artist, album, year: '' };
                const candidates = await new Promise(res => searchStreamingForApproval(albumInfo, res));
                if (candidates && candidates.length > 0) {
                    toRehost.push({ gid, imageUrl: null, name: `${artist} — ${album}`, needsApproval: true, candidates, albumInfo });
                    queuedForRehost = true;
                }
            }

            if (!queuedForRehost) {
                scannedThisRun.push(gid);
            }
        }

        addScannedGroups(scannedThisRun);

        const stoppedDuringScan = batchStopRequested;
        stopBtn.style.display = 'none';

        const toRehostFinal = toRehost.slice(0, limit);
        statusEl.textContent = `Found ${toRehost.length} with possible artwork out of ${scanned} checked (${removed} no longer exist — skipped).${stoppedDuringScan ? ' Stopped early.' : ''}`;
        foundCountEl.textContent = `${toRehost.length} found so far`;

        if (toRehostFinal.length === 0) {
            progressBar.style.width = '100%';
            startBtn.disabled = false; startBtn.textContent = 'Scan again';
            startBtn.onclick = triggerScan;
            refreshProcessedCountDisplay();
            return;
        }

        resultsEl.innerHTML = toRehostFinal.map((item, idx) => {
            if (item.needsApproval) {
                const thumbs = item.candidates.map((c, ci) =>
                    `<div style="display:inline-block;margin:4px;text-align:center;vertical-align:top;width:100px;">
                        <img src="${escHtml(c.imageUrl)}" style="width:100px;height:100px;object-fit:contain;background:#111;border-radius:4px;border:2px solid #333;cursor:pointer;" data-idx="${idx}" data-ci="${ci}" class="approval-thumb">
                        <div style="font-size:9px;color:#666;margin-top:2px;">${escHtml(c.searchSource)}</div>
                        <button class="approval-btn" data-idx="${idx}" data-ci="${ci}" style="margin-top:3px;padding:3px 8px;background:#4CAF50;color:#fff;border:none;border-radius:3px;cursor:pointer;font-size:10px;">✓ Use</button>
                    </div>`
                ).join('');
                return `<div id="batch-row-${idx}" style="padding:10px 12px;border-bottom:1px solid #222;font-size:12px;">
                    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
                        <a href="/torrents.php?id=${item.gid}" target="_blank" style="color:#4CAF50;text-decoration:none;font-weight:bold;">${escHtml(item.name)}</a>
                        <span style="display:flex;align-items:center;gap:6px;">
                            <span id="batch-status-${idx}" style="white-space:nowrap;color:#f59e0b;font-size:11px;">awaiting approval</span>
                            <button class="approval-skip" data-idx="${idx}" style="padding:3px 8px;background:#333;color:#aaa;border:none;border-radius:3px;cursor:pointer;font-size:10px;">✗ Skip</button>
                        </span>
                    </div>
                    <div style="font-size:10px;color:#666;margin-bottom:6px;">No embedded links found — streaming search results (${item.candidates.length} candidates):</div>
                    <div>${thumbs}</div>
                </div>`;
            }
            return `<div style="display:flex;align-items:center;gap:10px;padding:8px 12px;border-bottom:1px solid #222;font-size:12px;">
                <div style="flex:1;min-width:0;">
                    <a href="/torrents.php?id=${item.gid}" target="_blank" style="color:#4CAF50;text-decoration:none;">${escHtml(item.name)}</a>
                    <div style="color:#666;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">cover: ${escHtml(item.imageUrl)}</div>
                </div>
                <span id="batch-status-${idx}" style="white-space:nowrap;color:#888;">queued</span>
            </div>`;
        }).join('');

        resultsEl.querySelectorAll('.approval-btn').forEach(btn => {
            btn.onclick = () => {
                const idx = parseInt(btn.dataset.idx);
                const ci  = parseInt(btn.dataset.ci);
                const item = toRehostFinal[idx];
                item.imageUrl = item.candidates[ci].imageUrl;
                item.approved = true;
                const row = document.getElementById(`batch-row-${idx}`);
                const statusEl2 = document.getElementById(`batch-status-${idx}`);
                statusEl2.textContent = 'approved — queued';
                statusEl2.style.color = '#4CAF50';
                row.querySelectorAll('.approval-thumb').forEach((t, ti) => {
                    t.style.borderColor = ti === ci ? '#4CAF50' : '#222';
                    t.style.opacity = ti === ci ? '1' : '0.4';
                });
                row.querySelectorAll('.approval-btn').forEach(b => b.style.display = 'none');
                row.querySelector('.approval-skip').style.display = 'none';
            };
        });
        resultsEl.querySelectorAll('.approval-skip').forEach(btn => {
            btn.onclick = () => {
                const idx = parseInt(btn.dataset.idx);
                toRehostFinal[idx].skipped = true;
                const statusEl2 = document.getElementById(`batch-status-${idx}`);
                statusEl2.textContent = 'skipped';
                statusEl2.style.color = '#555';
            };
        });

        const hasApprovalItems = toRehostFinal.some(i => i.needsApproval);
        startBtn.disabled = false;
        startBtn.textContent = hasApprovalItems ? 'Done — Add Artwork (approve thumbnails below first)' : 'Done — Add Artwork';
        startBtn.onclick = doRehost;

        async function doRehost() {
            batchStopRequested = false;
            startBtn.disabled = true; startBtn.textContent = 'Uploading…';
            stopBtn.style.display = 'inline-block'; stopBtn.disabled = false; stopBtn.textContent = 'Stop';

            let done = 0;
            for (let i = 0; i < toRehostFinal.length; i++) {
                if (batchStopRequested) break;
                const item = toRehostFinal[i];
                if (item.skipped) continue;
                if (item.needsApproval && !item.approved) continue; // skip unapproved
                const { gid, imageUrl, name } = item;
                const rowStatus = document.getElementById(`batch-status-${i}`);
                rowStatus.textContent = 'uploading…'; rowStatus.style.color = 'orange';
                progressBar.style.width = `${Math.round(50 + (i / toRehostFinal.length) * 50)}%`;
                statusEl.textContent = `Uploading ${i + 1} of ${toRehostFinal.length}: ${name}`;

                try {
                    const newUrl = await batchUploadImage(imageUrl, apiKey);
                    if (newUrl) {
                        await apiPost(`ajax.php?action=groupedit&id=${gid}`, apiKey,
                            `image=${encodeURIComponent(newUrl)}&summary=${encodeURIComponent('Cover art added via CoverUp')}`);
                        rowStatus.textContent = '✓ added';
                        rowStatus.style.color = '#4CAF50';
                        done++; addProcessedGroup(gid);
                    } else {
                        rowStatus.textContent = '✗ upload failed'; rowStatus.style.color = '#ff4444';
                    }
                } catch(e) { rowStatus.textContent = '✗ error'; rowStatus.style.color = '#ff4444'; }
            }

            progressBar.style.width = '100%';
            statusEl.textContent = `Done! ${done} added.${batchStopRequested ? ' Stopped early.' : ''}`;
            startBtn.disabled = false; startBtn.textContent = 'Scan again';
            startBtn.onclick = triggerScan;
            stopBtn.style.display = 'none';
            refreshProcessedCountDisplay();
        }
    }

    // ============================================================
    // --- MISSING ARTIST IMAGE BATCH (better.php?method=cover) ---
    // ============================================================
    // A separate RED "better.php" list — this one is ARTISTS with no header/photo image
    // at all (confirmed live: ~1.37 million of them, so this is scanned in small batches
    // by design, same as the missing-artwork list above but at a much larger scale).
    // Unlike release covers, there's no bbcode/description to pull a source link from —
    // every candidate here comes from an artist-name search (Discogs/Deezer) and always
    // needs manual approval, since a same-named-artist mismatch is a much easier mistake
    // to make with photos than with album covers.
    function fetchBetterCoverPage(page) {
        return new Promise((resolve) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: `https://redacted.sh/better.php?page=${page}&method=cover`,
                timeout: 20000,
                onload: function(r) {
                    try {
                        const doc = new DOMParser().parseFromString(r.responseText, 'text/html');
                        const countMatch = doc.body.textContent.match(/There are ([\d,]+) artist groups remaining/);
                        const totalCount = countMatch ? parseInt(countMatch[1].replace(/,/g, ''), 10) : null;
                        const rows = [];
                        doc.querySelectorAll('tr.torrent_row').forEach(tr => {
                            const artistA = tr.querySelector('a[href*="artist.php"]');
                            if (!artistA) return;
                            let artistId = null;
                            try { artistId = new URL(artistA.getAttribute('href'), 'https://redacted.sh').searchParams.get('id'); } catch(e) {}
                            if (!artistId) return;
                            rows.push({ artistId, artistName: artistA.textContent.trim() });
                        });
                        resolve({ rows, totalCount });
                    } catch(e) {
                        console.warn('[CoverUp] fetchBetterCoverPage: parse error for page', page, e);
                        resolve({ rows: [], totalCount: null });
                    }
                },
                onerror:   () => { console.warn('[CoverUp] fetchBetterCoverPage: network error for page', page); resolve({ rows: [], totalCount: null }); },
                ontimeout: () => { console.warn('[CoverUp] fetchBetterCoverPage: timed out fetching page', page); resolve({ rows: [], totalCount: null }); },
            });
        });
    }

    function setupBetterCoverBatchPanel() {
        // Only on better.php?method=cover (RED's own "missing artist image" listing)
        if (!/better\.php/.test(window.location.pathname) || !/[?&]method=cover\b/.test(window.location.search)) return;

        const apiKey = getRedApiKey();
        if (!apiKey) return;

        const suggestedStart = getLastBetterCoverPage();

        const panel = document.createElement('div');
        panel.id = 'coverup-batch-panel';
        panel.style.cssText = 'background:#1a1a1a;border:2px solid #4CAF50;border-radius:10px;padding:20px;margin:16px 0;font-family:sans-serif;color:#fff;';
        panel.innerHTML = `
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">
                <div style="font-size:16px;font-weight:bold;color:#4CAF50;">🔴 CoverUp — Find Missing Artist Images</div>
                <div style="display:flex;align-items:center;gap:8px;">
                    <button id="batch-start" style="padding:9px 22px;background:#4CAF50;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:bold;font-size:14px;">Scan pages</button>
                    <button id="batch-stop" style="display:none;padding:9px 18px;background:#555;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:bold;font-size:14px;">Stop</button>
                    <button id="batch-panel-toggle" title="Hide the whole batch panel" style="padding:9px 18px;background:#555;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:bold;font-size:14px;flex-shrink:0;">Hide</button>
                </div>
            </div>
            <div id="batch-panel-body">
            <div style="background:#450a0a;border:1px solid #ef4444;border-radius:6px;padding:10px 12px;margin-bottom:10px;font-size:12px;color:#fca5a5;">
                <strong>⚠ Highly experimental — use at your own risk.</strong> This feature is newer and still somewhat manual compared to the rest of CoverUp. It searches for and adds a photo/header image to artists that have none — including artists you didn't add.
                There are well over a million artists on this list, so results always need your approval below before anything is saved — a same-named artist mismatch is easy to get wrong here.
            </div>
            <div id="batch-status" style="font-size:13px;color:#aaa;margin-bottom:10px;">
                Scans RED's own "missing artist image" list (over a million artists, 50 per page) and searches Discogs/Deezer by artist name for a candidate photo.
            </div>
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;font-size:12px;flex-wrap:wrap;">
                <label style="display:flex;align-items:center;gap:5px;color:#aaa;cursor:pointer;">
                    <input type="checkbox" id="better-cover-random-mode" checked>
                    🎲 Random pages
                </label>
                <label id="better-cover-start-page-label" style="display:none;align-items:center;gap:5px;color:#aaa;">
                    Start page
                    <input type="number" id="better-cover-start-page" value="${suggestedStart}" min="1"
                        style="width:64px;padding:4px 6px;background:#111;border:1px solid #555;color:#fff;border-radius:4px;font-size:12px;">
                </label>
                <label style="display:flex;align-items:center;gap:5px;color:#aaa;">
                    Pages to scan
                    <input type="number" id="better-cover-page-count" value="3" min="1" max="50"
                        style="width:56px;padding:4px 6px;background:#111;border:1px solid #555;color:#fff;border-radius:4px;font-size:12px;">
                </label>
                <span id="better-cover-mode-note" style="color:#666;">— 50 artists/page. The list is sorted alphabetically, so sequential pages near the start are mostly punctuation/special-character names — random pages spread the scan across the whole list instead.</span>
            </div>
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;font-size:12px;">
                <label style="display:flex;align-items:center;gap:5px;color:#aaa;cursor:pointer;">
                    <input type="checkbox" id="batch-test-mode" checked>
                    Test mode — limit to
                    <input type="number" id="batch-test-limit" value="5" min="1" max="50"
                        style="width:52px;padding:4px 6px;background:#111;border:1px solid #555;color:#fff;border-radius:4px;font-size:12px;">
                    found candidates
                </label>
            </div>
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;font-size:12px;color:#666;">
                <span id="batch-processed-count"></span>
                <a href="javascript:void(0)" id="batch-reset-processed" style="color:#555;text-decoration:underline;">Reset progress</a>
            </div>
            <div id="batch-progress-bar-wrap" style="display:none;background:#333;border-radius:4px;height:8px;margin-bottom:12px;">
                <div id="batch-progress-bar" style="background:#4CAF50;height:8px;border-radius:4px;width:0%;transition:width 0.3s;"></div>
            </div>
            <div id="batch-found-count" style="font-size:12px;color:#4CAF50;font-weight:bold;margin-bottom:6px;">0 found so far</div>
            <div id="batch-results" style="display:none;max-height:400px;overflow-y:auto;border:1px solid #333;border-radius:6px;"></div>
            </div>`;

        const target = document.querySelector('.thin') || document.querySelector('#content');
        if (target) target.prepend(panel);
        else document.body.prepend(panel);

        setupBatchPanelCollapse(panel);

        function refreshArtistProcessedCountDisplay() {
            const el = panel.querySelector('#batch-processed-count');
            if (!el) return;
            const lifetime = getLifetimeArtistImagesAddedCount();
            const nChecked = getProcessedArtists().size;
            const nAdded   = getAddedArtistImages().size;
            el.textContent = `${lifetime.toLocaleString()} artist images added all-time — ${nChecked.toLocaleString()} artists checked, ${nAdded.toLocaleString()} added since last reset`;
        }
        refreshArtistProcessedCountDisplay();

        panel.querySelector('#batch-reset-processed').onclick = () => {
            if (confirm('Clear saved scan progress for this list? All artists will be checked again from scratch next run.\n\n(Your all-time added count is not affected. Your saved "start page" position is also unaffected — reset that manually in the field above if you want to rescan from page 1.)')) {
                clearProcessedArtists();
                clearAddedArtistImages();
                refreshArtistProcessedCountDisplay();
            }
        };

        panel.querySelector('#batch-stop').onclick = () => {
            batchStopRequested = true;
            const stopBtn = panel.querySelector('#batch-stop');
            stopBtn.disabled = true;
            stopBtn.textContent = 'Stopping…';
        };

        const randomModeCheckbox = panel.querySelector('#better-cover-random-mode');
        const startPageLabel     = panel.querySelector('#better-cover-start-page-label');
        const modeNote           = panel.querySelector('#better-cover-mode-note');
        function syncRandomModeUI() {
            const isRandom = randomModeCheckbox.checked;
            startPageLabel.style.display = isRandom ? 'none' : 'flex';
            modeNote.textContent = isRandom
                ? '— 50 artists/page. The list is sorted alphabetically, so sequential pages near the start are mostly punctuation/special-character names — this picks random pages from across the whole list instead.'
                : '— 50 artists/page. Given the sheer volume, this remembers where you left off and picks up there next time.';
        }
        randomModeCheckbox.onchange = syncRandomModeUI;
        syncRandomModeUI();

        function triggerScan() {
            const randomMode = randomModeCheckbox.checked;
            const startPage  = parseInt(panel.querySelector('#better-cover-start-page').value) || 1;
            const pageCount  = parseInt(panel.querySelector('#better-cover-page-count').value) || 1;
            const testMode   = panel.querySelector('#batch-test-mode').checked;
            const testLimit  = parseInt(panel.querySelector('#batch-test-limit').value) || 5;
            runBetterCoverBatch(randomMode, startPage, pageCount, testMode ? testLimit : Infinity, panel, refreshArtistProcessedCountDisplay, triggerScan);
        }
        panel.querySelector('#batch-start').onclick = triggerScan;
    }

    async function runBetterCoverBatch(randomMode, startPage, pageCount, limit, panel, updateProcessedCount, triggerScan) {
        const startBtn     = panel.querySelector('#batch-start');
        const stopBtn      = panel.querySelector('#batch-stop');
        const statusEl     = panel.querySelector('#batch-status');
        const foundCountEl = panel.querySelector('#batch-found-count');
        const progressWrap = panel.querySelector('#batch-progress-bar-wrap');
        const progressBar  = panel.querySelector('#batch-progress-bar');
        const resultsEl    = panel.querySelector('#batch-results');

        batchStopRequested = false;
        startBtn.disabled = true;
        startBtn.textContent = 'Scanning…';
        stopBtn.style.display = 'inline-block';
        stopBtn.disabled = false;
        stopBtn.textContent = 'Stop';
        progressWrap.style.display = 'block';
        resultsEl.style.display = 'block';
        resultsEl.innerHTML = '';
        foundCountEl.textContent = '0 found so far';

        const processedArtists = getProcessedArtists();
        const ARTISTS_PER_PAGE = 50;

        let allRows = [];
        let totalCount = null;
        let pagesFetched = [];

        if (randomMode) {
            // The list is sorted alphabetically, so sequential pages cluster by leading
            // character — early pages are almost entirely punctuation/special-character
            // names. Pick random pages spread across the whole list instead. Needs the
            // total count first (from any page) to know the valid page range.
            statusEl.textContent = `Finding out how many pages there are…`;
            const first = await fetchBetterCoverPage(1);
            totalCount = first.totalCount;
            const maxPage = totalCount != null ? Math.max(1, Math.ceil(totalCount / ARTISTS_PER_PAGE)) : 1;

            const chosenPages = new Set();
            while (chosenPages.size < pageCount && chosenPages.size < maxPage) {
                chosenPages.add(1 + Math.floor(Math.random() * maxPage));
            }
            pagesFetched = [...chosenPages];

            for (const p of pagesFetched) {
                if (batchStopRequested) break;
                statusEl.textContent = `Fetching random page ${p} (${allRows.length ? 'so far ' + (pagesFetched.indexOf(p) + 1) + ' of ' + pagesFetched.length : '1 of ' + pagesFetched.length})…`;
                const { rows, totalCount: tc } = await fetchBetterCoverPage(p);
                if (tc != null) totalCount = tc;
                allRows = allRows.concat(rows);
                await sleep(400); // light pacing — cookie-based, not API-key-throttled
            }
            statusEl.textContent = `Fetched ${allRows.length} artists from ${pagesFetched.length} random page${pagesFetched.length === 1 ? '' : 's'} (of ${maxPage.toLocaleString()} total pages)…`;
        } else {
            const endPage = startPage + pageCount - 1;
            statusEl.textContent = `Fetching pages ${startPage}–${endPage}…`;
            for (let p = startPage; p <= endPage; p++) {
                if (batchStopRequested) break;
                statusEl.textContent = `Fetching page ${p} of ${startPage}–${endPage}…`;
                const { rows, totalCount: tc } = await fetchBetterCoverPage(p);
                if (tc != null) totalCount = tc;
                if (rows.length === 0) break; // ran past the last page — nothing more to fetch
                allRows = allRows.concat(rows);
                await sleep(400); // light pacing — cookie-based, not API-key-throttled
            }
            setLastBetterCoverPage(endPage + 1);
        }

        const unseenRows = allRows.filter(r => !processedArtists.has(String(r.artistId)));
        const pagesDescription = randomMode
            ? `${pagesFetched.length} random page${pagesFetched.length === 1 ? '' : 's'}`
            : `pages ${startPage}–${startPage + pageCount - 1}`;
        statusEl.textContent = `Fetched ${allRows.length} artists from ${pagesDescription}${totalCount != null ? ` (${totalCount.toLocaleString()} total remaining site-wide)` : ''}. ${unseenRows.length} not yet checked. Searching for photos…`;

        const candidates = [];
        const checkedThisRun = [];
        let scanned = 0;
        const scanLimit = limit < Infinity ? Math.min(limit * 10, unseenRows.length) : unseenRows.length;

        for (let i = 0; i < scanLimit; i++) {
            if (batchStopRequested) break;
            if (limit < Infinity && candidates.length >= limit) break;
            const { artistId, artistName } = unseenRows[i];
            scanned++;
            progressBar.style.width = `${Math.round((scanned / scanLimit) * 50)}%`;
            statusEl.textContent = `Checking ${scanned} of ${scanLimit}: ${artistName}…`;
            foundCountEl.textContent = `${candidates.length} found so far`;

            const items = await new Promise(res => searchArtistImageCandidates(artistName, res));
            checkedThisRun.push(artistId);
            if (items && items.length > 0) {
                candidates.push({ artistId, artistName, candidates: items });
            }
        }

        addProcessedArtists(checkedThisRun);

        const stoppedDuringScan = batchStopRequested;
        stopBtn.style.display = 'none';

        const candidatesFinal = candidates.slice(0, limit);
        statusEl.textContent = `Found ${candidates.length} with possible images out of ${scanned} checked.${stoppedDuringScan ? ' Stopped early.' : ''}`;
        foundCountEl.textContent = `${candidates.length} found so far`;

        if (candidatesFinal.length === 0) {
            progressBar.style.width = '100%';
            startBtn.disabled = false; startBtn.textContent = 'Scan again';
            startBtn.onclick = triggerScan;
            updateProcessedCount();
            return;
        }

        resultsEl.innerHTML = candidatesFinal.map((item, idx) => {
            const thumbs = item.candidates.map((c, ci) =>
                `<div style="display:inline-block;margin:4px;text-align:center;vertical-align:top;width:100px;">
                    ${c.pageUrl ? `<a href="${escHtml(c.pageUrl)}" target="_blank" title="Open ${escHtml(c.searchSource)} artist page to verify">` : ''}
                    <img src="${escHtml(c.imageUrl)}" style="width:100px;height:100px;object-fit:contain;background:#111;border-radius:4px;border:2px solid #333;cursor:pointer;" data-idx="${idx}" data-ci="${ci}" class="approval-thumb">
                    ${c.pageUrl ? `</a>` : ''}
                    <div style="font-size:9px;color:#666;margin-top:2px;">${escHtml(c.searchSource)}${c.label ? ' — ' + escHtml(c.label) : ''}</div>
                    <button class="approval-btn" data-idx="${idx}" data-ci="${ci}" style="margin-top:3px;padding:3px 8px;background:#4CAF50;color:#fff;border:none;border-radius:3px;cursor:pointer;font-size:10px;">✓ Use</button>
                </div>`
            ).join('');
            return `<div id="batch-row-${idx}" style="padding:10px 12px;border-bottom:1px solid #222;font-size:12px;">
                <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
                    <a href="/artist.php?id=${item.artistId}" target="_blank" style="color:#4CAF50;text-decoration:none;font-weight:bold;">${escHtml(item.artistName)}</a>
                    <span style="display:flex;align-items:center;gap:6px;">
                        <span id="batch-status-${idx}" style="white-space:nowrap;color:#f59e0b;font-size:11px;">awaiting approval</span>
                        <button class="approval-skip" data-idx="${idx}" style="padding:3px 8px;background:#333;color:#aaa;border:none;border-radius:3px;cursor:pointer;font-size:10px;">✗ Skip</button>
                    </span>
                </div>
                <div style="font-size:10px;color:#666;margin-bottom:6px;">${item.candidates.length} candidate${item.candidates.length === 1 ? '' : 's'} — check it's actually the right artist before approving:</div>
                <div>${thumbs}</div>
            </div>`;
        }).join('');

        resultsEl.querySelectorAll('.approval-btn').forEach(btn => {
            btn.onclick = () => {
                const idx = parseInt(btn.dataset.idx);
                const ci  = parseInt(btn.dataset.ci);
                const item = candidatesFinal[idx];
                item.chosenImageUrl = item.candidates[ci].imageUrl;
                item.approved = true;
                const row = document.getElementById(`batch-row-${idx}`);
                const statusEl2 = document.getElementById(`batch-status-${idx}`);
                statusEl2.textContent = 'approved — queued';
                statusEl2.style.color = '#4CAF50';
                row.querySelectorAll('.approval-thumb').forEach((t, ti) => {
                    t.style.borderColor = ti === ci ? '#4CAF50' : '#222';
                    t.style.opacity = ti === ci ? '1' : '0.4';
                });
                row.querySelectorAll('.approval-btn').forEach(b => b.style.display = 'none');
                row.querySelector('.approval-skip').style.display = 'none';
            };
        });
        resultsEl.querySelectorAll('.approval-skip').forEach(btn => {
            btn.onclick = () => {
                const idx = parseInt(btn.dataset.idx);
                candidatesFinal[idx].skipped = true;
                const statusEl2 = document.getElementById(`batch-status-${idx}`);
                statusEl2.textContent = 'skipped';
                statusEl2.style.color = '#555';
            };
        });

        startBtn.disabled = false;
        startBtn.textContent = 'Done — Add Images (approve thumbnails below first)';
        startBtn.onclick = doAdd;

        async function doAdd() {
            const apiKey = getRedApiKey();
            batchStopRequested = false;
            startBtn.disabled = true; startBtn.textContent = 'Uploading…';
            stopBtn.style.display = 'inline-block'; stopBtn.disabled = false; stopBtn.textContent = 'Stop';

            let done = 0;
            for (let i = 0; i < candidatesFinal.length; i++) {
                if (batchStopRequested) break;
                const item = candidatesFinal[i];
                if (item.skipped || !item.approved) continue;
                const { artistId, artistName, chosenImageUrl } = item;
                const rowStatus = document.getElementById(`batch-status-${i}`);
                rowStatus.textContent = 'uploading…'; rowStatus.style.color = 'orange';
                progressBar.style.width = `${Math.round(50 + (i / candidatesFinal.length) * 50)}%`;
                statusEl.textContent = `Uploading ${i + 1} of ${candidatesFinal.length}: ${artistName}`;

                try {
                    const newUrl = await batchUploadImage(chosenImageUrl, apiKey);
                    if (!newUrl) {
                        rowStatus.textContent = '✗ upload failed'; rowStatus.style.color = '#ff4444';
                        continue;
                    }
                    await new Promise(res => submitArtistImage(artistId, newUrl, (ok, err) => {
                        if (ok) {
                            rowStatus.textContent = '✓ added';
                            rowStatus.style.color = '#4CAF50';
                            done++;
                            addAddedArtistImage(artistId);
                            foundCountEl.textContent = `${done} found and hosted so far`;
                        } else {
                            rowStatus.textContent = `✗ save failed${err ? ' (' + err + ')' : ''}`;
                            rowStatus.style.color = '#ff4444';
                        }
                        res();
                    }));
                } catch(e) { rowStatus.textContent = '✗ error'; rowStatus.style.color = '#ff4444'; }
            }

            progressBar.style.width = '100%';
            statusEl.textContent = `Done! ${done} added.${batchStopRequested ? ' Stopped early.' : ''}`;
            startBtn.disabled = false; startBtn.textContent = 'Scan again';
            startBtn.onclick = triggerScan;
            stopBtn.style.display = 'none';
            updateProcessedCount();
        }
    }

    function setupCollageBatchPanel() {
        // Only on collages.php?userid=X (list of collages pages)
        const isCollagePage = /collages\.php/.test(window.location.pathname)
            && /[?&]userid=\d+/.test(window.location.search)
            && !/[?&]id=\d+/.test(window.location.search);
        if (!isCollagePage) return;

        const apiKey = getRedApiKey();
        if (!apiKey) return;

        const userIdMatch = window.location.search.match(/[?&]userid=(\d+)/);
        const userId = userIdMatch ? userIdMatch[1] : null;
        if (!userId) return;

        const isContrib = /[?&]contrib=1/.test(window.location.search);

        // Inject panel before the collage table
        const panel = document.createElement('div');
        panel.id = 'coverup-batch-panel';
        panel.style.cssText = 'background:#1a1a1a;border:2px solid #4CAF50;border-radius:10px;padding:20px;margin:16px 0;font-family:sans-serif;color:#fff;';
        panel.innerHTML = `
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">
                <div style="font-size:16px;font-weight:bold;color:#4CAF50;">🔴 CoverUp — Batch Rehost Collage Covers</div>
                <div style="display:flex;align-items:center;gap:8px;">
                    <button id="batch-fix-desc-imgs-all" title="Rehost geoblocked/rehostable images (e.g. imgur) found in every collage's own description" style="padding:9px 14px;background:#333;color:#ccc;border:none;border-radius:6px;cursor:pointer;font-weight:bold;font-size:14px;white-space:nowrap;">🖼 Fix Description Images (all collages)</button>
                    <button id="batch-start" style="padding:9px 22px;background:#4CAF50;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:bold;font-size:14px;">Scan collages</button>
                    <button id="batch-stop" style="display:none;padding:9px 18px;background:#555;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:bold;font-size:14px;">Stop</button>
                    <button id="batch-panel-toggle" title="Hide the whole batch panel" style="padding:9px 18px;background:#555;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:bold;font-size:14px;flex-shrink:0;">Hide</button>
                </div>
            </div>
            <div id="batch-panel-body">
            <div style="background:#450a0a;border:1px solid #ef4444;border-radius:6px;padding:10px 12px;margin-bottom:10px;font-size:12px;color:#fca5a5;">
                <strong>⚠ Use at your own risk.</strong> Batch mode automatically updates torrent group metadata.
                Test with a small number first and check results manually.
            </div>
            <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:10px;">
                <div id="batch-status" style="font-size:13px;color:#aaa;flex:1;">
                    Scans all releases in ${isContrib ? 'collages you contributed to' : 'your collages'} for covers that need rehosting to RED's image host.
                </div>
                <span id="batch-found-count" style="font-size:12px;color:#4CAF50;font-weight:bold;white-space:nowrap;">0 found so far</span>
            </div>
            ${renderBatchRunModeSelector()}
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;font-size:12px;color:#666;">
                <span id="batch-processed-count"></span>
                <a href="javascript:void(0)" id="batch-reset-page-processed" style="color:#555;text-decoration:underline;">Reset progress for these collages only</a>
                <a href="javascript:void(0)" id="batch-reset-processed" style="color:#555;text-decoration:underline;">Reset all progress</a>
            </div>
            <div id="batch-progress-bar-wrap" style="display:none;background:#333;border-radius:4px;height:8px;margin-bottom:12px;">
                <div id="batch-progress-bar" style="background:#4CAF50;height:8px;border-radius:4px;width:0%;transition:width 0.3s;"></div>
            </div>
            <div id="batch-results" style="display:none;max-height:400px;overflow-y:auto;border:1px solid #333;border-radius:6px;"></div>
            <div style="display:flex;align-items:center;gap:10px;margin:10px 0 0;font-size:12px;color:#666;">
                <span id="batch-desc-scanned-count"></span>
                <a href="javascript:void(0)" id="batch-reset-desc-scanned" style="color:#555;text-decoration:underline;">Reset description-scan progress</a>
            </div>
            <div id="batch-desc-imgs-results" style="display:none;max-height:400px;overflow-y:auto;border:1px solid #333;border-radius:6px;margin-top:10px;"></div>
            </div>`;

        const target = document.querySelector('.thin') || document.querySelector('#content');
        if (target) target.prepend(panel);

        setupBatchPanelCollapse(panel);
        wireBatchRunModeSelector(panel);
        refreshProcessedCountDisplay();

        function refreshDescScannedCount() {
            panel.querySelector('#batch-desc-scanned-count').textContent = `${getScannedCollageDescriptions().size} collage description(s) already scanned (site-wide)`;
        }
        refreshDescScannedCount();

        panel.querySelector('#batch-reset-desc-scanned').onclick = () => {
            if (confirm('Clear the "already scanned" log for collage descriptions? The next description-image scan will re-check every collage, even ones already confirmed clean.\n\n(This does not undo any already-fixed descriptions.)')) {
                clearScannedCollageDescriptions();
                refreshDescScannedCount();
            }
        };

        panel.querySelector('#batch-reset-page-processed').onclick = async () => {
            if (!confirm(`Re-check every group across ${isContrib ? 'collages you contributed to' : 'your collages'} from scratch? Groups already confirmed fine or rehosted elsewhere are unaffected.`)) return;
            const link = panel.querySelector('#batch-reset-page-processed');
            const prevText = link.textContent;
            link.textContent = 'Fetching list…';
            const groupInfo = await fetchCollageGroupIds(userId, apiKey, isContrib, panel.querySelector('#batch-status'));
            const affected = removeGroupsFromProgress([...groupInfo.keys()]);
            link.textContent = prevText;
            refreshProcessedCountDisplay();
            alert(`Cleared ${affected} group(s) — they'll be re-checked on the next scan.`);
        };

        panel.querySelector('#batch-reset-processed').onclick = () => {
            if (confirm('Clear saved scan progress? All groups will be checked again from scratch next run.\n\n(Your all-time rehosted count is not affected.)')) {
                clearProcessedGroups();
                clearScannedGroups();
                clearFastScannedGroups();
                refreshProcessedCountDisplay();
            }
        };

        panel.querySelector('#batch-stop').onclick = () => {
            batchStopRequested = true;
            const stopBtn = panel.querySelector('#batch-stop');
            stopBtn.disabled = true;
            stopBtn.textContent = 'Stopping…';
        };

        panel.querySelector('#batch-fix-desc-imgs-all').onclick = async () => {
            if (!confirm(`Scan every ${isContrib ? 'collage you contributed to' : 'collage you own'} for rehostable description images (e.g. imgur) and fix them in place?`)) return;
            const statusEl = panel.querySelector('#batch-status');
            const collageIds = await fetchUserCollageIds(userId, apiKey, isContrib, statusEl);
            if (collageIds.length === 0) {
                statusEl.textContent = 'No collages found.';
                return;
            }
            await runCollageDescriptionImageBatch(collageIds, apiKey, panel);
            refreshDescScannedCount();
        };

        function triggerScan() {
            const { limit, ptpimgOnlyMode } = getBatchRunMode(panel);
            runCollageBatch(userId, apiKey, isContrib, limit, panel, refreshProcessedCountDisplay, triggerScan, ptpimgOnlyMode);
        }
        panel.querySelector('#batch-start').onclick = triggerScan;
    }

    // The general/unscoped "Browse collages" page (collages.php with no userid/id
    // params) lists collages site-wide, not just the current user's own/contributed-to
    // ones. There's no ajax.php endpoint for this list, but the collage id + name are
    // both right there in the page's own HTML (<a href="collages.php?id=X">Name</a>),
    // so this scrapes them directly instead of going through the API.
    function setupGeneralCollageBrowseBatchPanel() {
        const isGeneralBrowsePage = /collages\.php/.test(window.location.pathname)
            && !/[?&]userid=\d+/.test(window.location.search)
            && !/[?&]id=\d+/.test(window.location.search);
        if (!isGeneralBrowsePage) return;

        const apiKey = getRedApiKey();
        if (!apiKey) return;

        const currentPageMatch = window.location.search.match(/[?&]page=(\d+)/);
        const currentPage = currentPageMatch ? parseInt(currentPageMatch[1], 10) : 1;
        const suggestedStart = getLastGeneralCollagePage();

        const panel = document.createElement('div');
        panel.id = 'coverup-general-collage-panel';
        panel.style.cssText = 'background:#1a1a1a;border:2px solid #4CAF50;border-radius:10px;padding:20px;margin:16px 0;font-family:sans-serif;color:#fff;';
        panel.innerHTML = `
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">
                <div style="font-size:16px;font-weight:bold;color:#4CAF50;">🔴 CoverUp — Fix Description Images (browse collages)</div>
                <button id="batch-panel-toggle" title="Hide the whole panel" style="padding:9px 18px;background:#555;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:bold;font-size:14px;flex-shrink:0;">Hide</button>
            </div>
            <div id="batch-panel-body">
            <div id="batch-status" style="font-size:13px;color:#aaa;margin-bottom:10px;">
                Scans any collage on this browse page (not just yours) for geoblocked/rehostable images (e.g. imgur) in its description and moves them to RED's image host.
            </div>
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;font-size:12px;flex-wrap:wrap;">
                <label style="display:flex;align-items:center;gap:5px;color:#aaa;">
                    Start page
                    <input type="number" id="gcb-page-start" value="${suggestedStart}" min="1"
                        style="width:64px;padding:4px 6px;background:#111;border:1px solid #555;color:#fff;border-radius:4px;font-size:12px;">
                </label>
                <label style="display:flex;align-items:center;gap:5px;color:#aaa;">
                    Pages to scan
                    <input type="number" id="gcb-page-count" value="3" min="1" max="50"
                        style="width:56px;padding:4px 6px;background:#111;border:1px solid #555;color:#fff;border-radius:4px;font-size:12px;">
                </label>
                <span style="color:#666;">— this remembers where you left off, so each run picks up where the last one ended.</span>
                <button id="gcb-start" style="padding:9px 22px;background:#4CAF50;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:bold;font-size:14px;margin-left:auto;">🖼 Fix Description Images</button>
            </div>
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;font-size:12px;color:#666;">
                <span id="gcb-scanned-count"></span>
                <a href="javascript:void(0)" id="gcb-reset-scanned" style="color:#555;text-decoration:underline;">Reset scan progress</a>
            </div>
            <div id="batch-desc-imgs-results" style="display:none;max-height:400px;overflow-y:auto;border:1px solid #333;border-radius:6px;"></div>
            </div>`;

        const target = document.querySelector('.thin') || document.querySelector('#content');
        if (target) target.prepend(panel);

        setupBatchPanelCollapse(panel);

        function refreshGcbScannedCount() {
            panel.querySelector('#gcb-scanned-count').textContent = `${getScannedCollageDescriptions().size} collage description(s) already scanned (site-wide)`;
        }
        refreshGcbScannedCount();

        panel.querySelector('#gcb-reset-scanned').onclick = () => {
            if (confirm('Clear the "already scanned" log for collage descriptions? The next batch will re-check every collage in the selected page range, even ones already confirmed clean.\n\n(This does not undo any already-fixed descriptions.)')) {
                clearScannedCollageDescriptions();
                refreshGcbScannedCount();
            }
        };

        panel.querySelector('#gcb-start').onclick = async () => {
            const startPage = Math.max(1, parseInt(panel.querySelector('#gcb-page-start').value, 10) || suggestedStart);
            const pageCount = Math.max(1, parseInt(panel.querySelector('#gcb-page-count').value, 10) || 1);
            const endPage = startPage + pageCount - 1;
            if (pageCount > 10 && !confirm(`Scan ${pageCount} pages of collages (~${pageCount * 25} collages)? Requests are automatically paced to stay within RED's rate limits, so it's safe to run — just note that a large range will take a while to finish.`)) {
                return;
            }
            const statusEl = panel.querySelector('#batch-status');
            const collageIds = await fetchGeneralBrowseCollageIds(startPage, endPage, statusEl);
            setLastGeneralCollagePage(endPage + 1);
            panel.querySelector('#gcb-page-start').value = endPage + 1;
            if (collageIds.length === 0) {
                statusEl.textContent = 'No collages found on the selected page(s).';
                return;
            }
            await runCollageDescriptionImageBatch(collageIds, apiKey, panel, '#gcb-start', '🖼 Fix Description Images');
            refreshGcbScannedCount();
        };
    }

    // Scrapes collage id+name pairs directly from collages.php's own HTML (no API
    // endpoint covers the general/unscoped browse list) across a page range, preserving
    // any existing search/filter query params already on the URL.
    function fetchGeneralBrowseCollageIds(startPage, endPage, statusEl) {
        return new Promise((resolve) => {
            const collagesOut = [];
            const seen = new Set();
            const baseUrl = new URL(window.location.href);

            function fetchPage(page) {
                if (page > endPage) { resolve(collagesOut); return; }
                if (statusEl) statusEl.textContent = `Fetching collage list (page ${page - startPage + 1} of ${endPage - startPage + 1})…`;
                const pageUrl = new URL(baseUrl.href);
                pageUrl.searchParams.set('page', String(page));
                GM_xmlhttpRequest({
                    method: 'GET',
                    url: pageUrl.href,
                    timeout: 20000,
                    onload: function(r) {
                        try {
                            const doc = new DOMParser().parseFromString(r.responseText, 'text/html');
                            const links = [...doc.querySelectorAll('a[href*="collages.php?id="]')];
                            links.forEach(a => {
                                const m = a.getAttribute('href').match(/id=(\d+)/);
                                if (!m) return;
                                const id = m[1];
                                if (seen.has(id)) return;
                                seen.add(id);
                                collagesOut.push({ id, name: a.textContent.trim() || `Collage ${id}` });
                            });
                        } catch (e) { /* ignore malformed page */ }
                        fetchPage(page + 1);
                    },
                    onerror: function() { fetchPage(page + 1); }
                });
            }
            fetchPage(startPage);
        });
    }

    // Gazelle's action=collage response already includes each release's wikiImage
    // (and name) in its torrentgroups array — keep that instead of just the bare ID
    // list, so the scan loop can classify covers without a separate per-group call.
    async function fetchCollageGroupIds(userId, apiKey, isContrib, statusEl) {
        const groups = new Map();
        let page = 1;
        while (true) {
            const url = `ajax.php?action=collages&userid=${userId}${isContrib ? '&contrib=1' : ''}&page=${page}`;
            const data = await apiGet(url, apiKey);
            if (!data || data.status !== 'success') break;
            const collages = data.response.results || data.response.collages || data.response || [];
            if (!Array.isArray(collages) || collages.length === 0) break;

            for (const col of collages) {
                const colId = col.id || col.collageid || col.collageId;
                if (!colId) continue;
                statusEl.textContent = `Fetching collage ${colId}…`;
                const colData = await apiGet(`ajax.php?action=collage&id=${colId}&showonlygroups=1`, apiKey);
                if (!colData || colData.status !== 'success' || !colData.response) continue;

                // torrentGroupIDList is the complete, unpaginated list of every group in
                // the collage — seed every group as "unknown" (falls back to a per-group
                // fetch, exactly like before this optimization existed) so large collages
                // never silently lose groups beyond page 1. The enriched torrentgroups
                // array (wikiImage/name) is paginated at ~50/page — only page 1's data is
                // free (it comes back on this same call), so that's all we use here.
                // Deliberately NOT paging through the rest: for a large collage — or a
                // user with many collages — that would just tack extra API calls onto the
                // per-group scan instead of replacing it.
                (colData.response.torrentGroupIDList || []).forEach(gid => {
                    if (!groups.has(String(gid))) groups.set(String(gid), { wikiImage: null, name: String(gid) });
                });
                const page1List = colData.response.torrentgroups;
                if (Array.isArray(page1List)) {
                    page1List.forEach(g => {
                        const gid = g.id ?? g.groupId ?? null;
                        if (gid != null) groups.set(String(gid), { wikiImage: (g.wikiImage || '').trim(), name: g.name || String(gid) });
                    });
                }
            }
            if (collages.length < 25) break;
            page++;
        }
        return groups;
    }

    // Lighter-weight than fetchCollageGroupIds above — just the collage IDs/names
    // themselves (no per-collage group fetch), for batch operations that act on each
    // collage as a whole rather than on the releases inside them.
    async function fetchUserCollageIds(userId, apiKey, isContrib, statusEl) {
        const collagesOut = [];
        let page = 1;
        while (true) {
            if (statusEl) statusEl.textContent = `Fetching collage list (page ${page})…`;
            const url = `ajax.php?action=collages&userid=${userId}${isContrib ? '&contrib=1' : ''}&page=${page}`;
            const data = await apiGet(url, apiKey);
            if (!data || data.status !== 'success') break;
            const collages = data.response.results || data.response.collages || data.response || [];
            if (!Array.isArray(collages) || collages.length === 0) break;
            collages.forEach(col => {
                const colId = col.id || col.collageid || col.collageId;
                if (colId) collagesOut.push({ id: String(colId), name: col.name || `Collage ${colId}` });
            });
            if (collages.length < 25) break;
            page++;
        }
        return collagesOut;
    }

    async function runCollageDescriptionImageBatch(collageIds, apiKey, panel, buttonSelector = '#batch-fix-desc-imgs-all', idleLabel = '🖼 Fix Description Images (all collages)', forceRescan = false) {
        const startBtn  = panel.querySelector(buttonSelector);
        const statusEl  = panel.querySelector('#batch-status');
        const resultsEl = panel.querySelector('#batch-desc-imgs-results');

        startBtn.disabled = true;
        startBtn.textContent = 'Scanning…';
        resultsEl.style.display = 'block';
        resultsEl.innerHTML = '';

        const alreadyScanned = getScannedCollageDescriptions();
        const toCheck = forceRescan ? collageIds : collageIds.filter(c => !alreadyScanned.has(String(c.id)));
        const previouslySkipped = collageIds.length - toCheck.length;

        let fixed = 0, skipped = 0, errored = 0;
        const newlyScanned = [];
        const needsReview = [];
        for (let i = 0; i < toCheck.length; i++) {
            const { id, name } = toCheck[i];
            statusEl.textContent = `Checking collage ${i + 1} of ${toCheck.length}: ${name}…`;
            const result = await processCollageDescriptionImages(id, apiKey);
            const row = document.createElement('div');
            row.style.cssText = 'padding:6px 10px;border-bottom:1px solid #222;font-size:12px;';
            const isFixed = result.ok && result.uploaded > 0;
            const hasDeadBandcamp = (result.deadBandcampUrls || []).length > 0;
            const color = isFixed ? '#4CAF50' : (hasDeadBandcamp ? '#e8a33d' : (result.ok ? '#888' : '#ff4444'));
            row.innerHTML = `<a href="/collages.php?id=${id}" target="_blank" style="color:#4CAF50;text-decoration:none;">${escHtml(name)}</a> — <span style="color:${color};">${escHtml(result.msg)}</span>`;
            resultsEl.appendChild(row);
            resultsEl.scrollTop = resultsEl.scrollHeight;
            if (isFixed) fixed++;
            else if (result.ok) skipped++;
            else errored++;
            // Only mark collages the fetch/scan itself actually completed for — a
            // fetch/auth error leaves it eligible to be retried next run.
            if (result.ok) newlyScanned.push(id);
            if (hasDeadBandcamp) needsReview.push({ id, name, count: result.deadBandcampUrls.length });
        }
        addScannedCollageDescriptions(newlyScanned);

        // Dead Bandcamp covers can't be safely auto-fixed (no live source URL left in
        // the description to pull from), so they're surfaced here as a distinct list
        // for a manual look, after the main easy-rehosting pass above rather than
        // interrupting it.
        if (needsReview.length > 0) {
            const reviewHeader = document.createElement('div');
            reviewHeader.style.cssText = 'padding:10px;margin-top:6px;border-top:2px solid #e8a33d;font-size:12px;color:#e8a33d;font-weight:bold;';
            reviewHeader.textContent = `🎧 ${needsReview.length} collage(s) with dead Bandcamp cover art — worth a manual look:`;
            resultsEl.appendChild(reviewHeader);
            needsReview.forEach(({ id, name, count }, reviewIndex) => {
                const row = document.createElement('div');
                row.style.cssText = 'padding:8px 10px;border-bottom:1px solid #222;font-size:12px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;';
                const searchUrl = `https://bandcamp.com/search?q=${encodeURIComponent(name)}`;
                row.innerHTML = `
                    <a href="/collages.php?id=${id}" target="_blank" style="color:#4CAF50;text-decoration:none;">${escHtml(name)}</a>
                    <span style="color:#aaa;">${count} dead cover(s)</span>
                    <span class="bc-lookup-status" style="color:#888;">🔍 looking up label art…</span>
                    <a href="${searchUrl}" target="_blank" style="color:#e8a33d;text-decoration:underline;margin-left:auto;">search Bandcamp manually</a>
                `;
                resultsEl.appendChild(row);

                // Kicked off in the background per row, after the main pass has already
                // finished — a best-effort suggestion the user visually confirms and
                // applies with one click, never auto-applied.
                (async () => {
                    await sleep(reviewIndex * 400); // stagger lookups — considerate to Bandcamp's own servers
                    const found = await searchBandcampLabelArt(name);
                    const statusSpan = row.querySelector('.bc-lookup-status');
                    if (!found || !found.artUrl) {
                        statusSpan.textContent = found && found.bandcampUrl
                            ? `no clear label art found — check the page`
                            : 'no confident Bandcamp match';
                        if (found && found.bandcampUrl) {
                            const bcLink = document.createElement('a');
                            bcLink.href = found.bandcampUrl;
                            bcLink.target = '_blank';
                            bcLink.textContent = 'open ' + new URL(found.bandcampUrl).hostname;
                            bcLink.style.cssText = 'color:#e8a33d;text-decoration:underline;';
                            statusSpan.after(bcLink);
                        }
                        return;
                    }
                    statusSpan.remove();
                    const thumb = document.createElement('img');
                    thumb.src = found.artUrl;
                    thumb.style.cssText = 'width:36px;height:36px;object-fit:cover;border-radius:4px;border:1px solid #444;';
                    const bcLink = document.createElement('a');
                    bcLink.href = found.bandcampUrl;
                    bcLink.target = '_blank';
                    bcLink.textContent = new URL(found.bandcampUrl).hostname;
                    bcLink.style.cssText = 'color:#888;text-decoration:underline;font-size:11px;';
                    const applyBtn = document.createElement('button');
                    applyBtn.textContent = '✓ Use this cover';
                    applyBtn.style.cssText = 'padding:5px 10px;background:#4CAF50;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:11px;font-weight:bold;';
                    const searchLink = row.querySelector('a[href="' + searchUrl + '"]');
                    row.insertBefore(thumb, searchLink);
                    row.insertBefore(bcLink, searchLink);
                    row.insertBefore(applyBtn, searchLink);
                    applyBtn.onclick = async () => {
                        applyBtn.disabled = true;
                        applyBtn.textContent = 'Applying…';
                        const result = await applyBandcampArtToCollage(id, found.artUrl, apiKey);
                        applyBtn.remove();
                        const resultSpan = document.createElement('span');
                        resultSpan.style.color = result.ok ? '#4CAF50' : '#ff4444';
                        resultSpan.textContent = (result.ok ? '✓ ' : '✗ ') + result.msg;
                        row.insertBefore(resultSpan, searchLink);
                    };
                })();
            });
            resultsEl.scrollTop = resultsEl.scrollHeight;
        }

        const skipNote = previouslySkipped > 0 ? ` (${previouslySkipped} already scanned previously — skipped)` : '';
        const reviewNote = needsReview.length > 0 ? `, ${needsReview.length} flagged for review (dead Bandcamp art)` : '';
        statusEl.textContent = `Done. ${fixed} collage(s) fixed, ${skipped} had nothing to do, ${errored} errors${reviewNote}${skipNote}.`;
        startBtn.disabled = false;
        startBtn.textContent = idleLabel;
    }

    async function runCollageBatch(userId, apiKey, isContrib, limit, panel, updateProcessedCount, triggerScan, ptpimgOnlyMode = false) {
        const startBtn     = panel.querySelector('#batch-start');
        const stopBtn      = panel.querySelector('#batch-stop');
        const statusEl     = panel.querySelector('#batch-status');
        const foundCountEl = panel.querySelector('#batch-found-count');
        const progressWrap = panel.querySelector('#batch-progress-bar-wrap');
        const progressBar  = panel.querySelector('#batch-progress-bar');
        const resultsEl    = panel.querySelector('#batch-results');

        batchStopRequested = false;
        startBtn.disabled = true;
        startBtn.textContent = 'Scanning…';
        stopBtn.style.display = 'inline-block';
        stopBtn.disabled = false;
        stopBtn.textContent = 'Stop';
        progressWrap.style.display = 'block';
        resultsEl.style.display = 'block';
        resultsEl.innerHTML = '';
        foundCountEl.textContent = '0 found so far';

        statusEl.textContent = 'Fetching collage group IDs…';
        const groupInfo = await fetchCollageGroupIds(userId, apiKey, isContrib, statusEl);
        const allGroupIds = [...groupInfo.keys()];

        const processedGroups   = getProcessedGroups();
        const scannedGroups     = getScannedGroups();
        const fastScannedGroups = getFastScannedGroups();
        const unseenGroupIds = allGroupIds.filter(g => {
            const key = String(g);
            if (processedGroups.has(key) || scannedGroups.has(key)) return false;
            if (ptpimgOnlyMode && fastScannedGroups.has(key)) return false;
            return true;
        });
        const groupIds = [...unseenGroupIds].sort(() => Math.random() - 0.5);

        statusEl.textContent = `Found ${allGroupIds.length} unique groups across collages (${groupIds.length} not yet checked). Checking covers…`;

        const toRehost = [];
        const skipped  = { ptpimg: 0, alreadyRed: 0, noImage: 0 };
        const scannedThisRun     = [];
        const fastScannedThisRun = [];
        let scanned = 0;
        const scanLimit = limit < Infinity ? Math.min(limit * 10, groupIds.length) : groupIds.length;

        for (let i = 0; i < scanLimit; i++) {
            if (batchStopRequested) break;
            if (limit < Infinity && toRehost.length >= limit) break;
            const gid = groupIds[i];
            scanned++;
            progressBar.style.width = `${Math.round((scanned / scanLimit) * 50)}%`;
            statusEl.textContent = `Checking group ${scanned} of ${scanLimit}…`;
            foundCountEl.textContent = `${toRehost.length} found so far`;

            // Cover host is already known from the bulk collage fetch — classify it for
            // free, with zero API calls, before ever touching torrentgroup. wikiImage is
            // null (rather than '') only in the rare defensive-fallback case, meaning it's
            // genuinely unknown — that always falls through to a full per-group fetch below.
            const info      = groupInfo.get(String(gid));
            const knownImage = info && info.wikiImage !== null ? info.wikiImage : undefined;
            const name       = (info && info.name) || gid;

            let coverNeedsRehost = false;
            let queuedForRehost  = false;
            // Fast Mode only ever performs a shallow, partial check (ptpimg cache only) —
            // when it gives up on a group for that reason, that's not a real verdict, so
            // the group must stay eligible for a later Deep Mode run.
            let shallowSkip = false;
            let imageUrl = knownImage || '';
            if (knownImage !== undefined) {
                if (!knownImage) { skipped.noImage++; }
                else {
                    const h = (() => { try { return new URL(knownImage).hostname.toLowerCase(); } catch(e) { return ''; } })();
                    if (ptpimgOnlyMode && !h.includes('ptpimg.me')) {
                        // ptpimg-only mode: ignore every other category for speed —
                        // don't mark scanned, since we never actually evaluated it.
                        shallowSkip = true;
                    } else if (h.includes('redacted.sh') || h.includes('images.redacted.sh')) {
                        if (isRedThumbnailUrl(knownImage)) {
                            toRehost.push({ gid, imageUrl: null, alreadyHosted: upgradeRedThumbnailUrl(knownImage), descImgUrls: [], bbBody: null, name });
                            queuedForRehost = true;
                        } else {
                            skipped.alreadyRed++;
                        }
                    } else if (h.includes('ptpimg.me')) {
                        statusEl.textContent = `Checking group ${scanned} of ${scanLimit} — ptpimg detected, trying RED cache…`;
                        const recoveredUrl = await uploadUrlToRed(knownImage, apiKey);
                        if (recoveredUrl) {
                            toRehost.push({ gid, imageUrl: null, alreadyHosted: recoveredUrl, descImgUrls: [], bbBody: null, name });
                            queuedForRehost = true;
                        } else if (ptpimgOnlyMode) {
                            // Shallow check (cache only) — don't mark scanned.
                            skipped.ptpimg++;
                            shallowSkip = true;
                        } else {
                            statusEl.textContent = `Checking group ${scanned} of ${scanLimit} — checking source links…`;
                            const sourceImageUrl = await new Promise(res => fetchGroupPageAndResolveImage(gid, '', res));
                            if (sourceImageUrl) {
                                toRehost.push({ gid, imageUrl: sourceImageUrl, descImgUrls: [], bbBody: null, name, viaSources: true });
                                queuedForRehost = true;
                            } else {
                                skipped.ptpimg++;
                            }
                        }
                    } else if (!ptpimgOnlyMode && needsBatchRehost(knownImage)) {
                        coverNeedsRehost = true;
                    }
                }
            }

            // Only groups whose cover actually needs rehosting (or whose cover status is
            // still unknown, per the rare fallback above) pay for the extra torrentgroup
            // API call. Confirmed clean-cover groups never reach here — that's the speedup.
            if (!queuedForRehost && (coverNeedsRehost || knownImage === undefined)) {
                const groupData = await apiGet(`ajax.php?action=torrentgroup&id=${gid}`, apiKey);
                if (!groupData || groupData.status !== 'success') continue;
                const group  = groupData.response.group;
                const bbBody = group.bbBody || group.wikiBody || '';
                if (knownImage === undefined) {
                    // Redo the classification now that we actually have the real wikiImage.
                    imageUrl = (group.wikiImage || '').trim();
                    if (!imageUrl) { skipped.noImage++; }
                    else {
                        const h = (() => { try { return new URL(imageUrl).hostname.toLowerCase(); } catch(e) { return ''; } })();
                        if (ptpimgOnlyMode && !h.includes('ptpimg.me')) {
                            // ptpimg-only mode: ignore every other category for speed —
                            // don't mark scanned, since we never actually evaluated it.
                            shallowSkip = true;
                        } else if (h.includes('redacted.sh') || h.includes('images.redacted.sh')) {
                            if (isRedThumbnailUrl(imageUrl)) {
                                toRehost.push({ gid, imageUrl: null, alreadyHosted: upgradeRedThumbnailUrl(imageUrl), descImgUrls: [], bbBody: null, name: group.name || name });
                                queuedForRehost = true;
                            } else {
                                skipped.alreadyRed++;
                            }
                        }
                        else if (h.includes('ptpimg.me')) {
                            const recoveredUrl = await uploadUrlToRed(imageUrl, apiKey);
                            if (recoveredUrl) {
                                toRehost.push({ gid, imageUrl: null, alreadyHosted: recoveredUrl, descImgUrls: [], bbBody: null, name: group.name || name });
                                queuedForRehost = true;
                            } else if (ptpimgOnlyMode) {
                                // Shallow check (cache only) — don't mark scanned.
                                skipped.ptpimg++;
                                shallowSkip = true;
                            } else {
                                const sourceImageUrl = await new Promise(res => fetchGroupPageAndResolveImage(gid, bbBody, res));
                                if (sourceImageUrl) {
                                    toRehost.push({ gid, imageUrl: sourceImageUrl, descImgUrls: [], bbBody: null, name: group.name || name, viaSources: true });
                                    queuedForRehost = true;
                                } else { skipped.ptpimg++; }
                            }
                        } else if (!ptpimgOnlyMode && needsBatchRehost(imageUrl)) { coverNeedsRehost = true; }
                    }
                }
                if (!ptpimgOnlyMode && !queuedForRehost && coverNeedsRehost) {
                    const descImgUrls = extractBBCodeImgUrls(bbBody).filter(needsDescriptionRehost);
                    toRehost.push({ gid, imageUrl, descImgUrls, bbBody: descImgUrls.length > 0 ? bbBody : null, name: group.name || name });
                    queuedForRehost = true;
                }
            }

            if (!queuedForRehost) {
                if (shallowSkip) {
                    fastScannedThisRun.push(gid);
                } else {
                    scannedThisRun.push(gid);
                }
            }
        }

        addScannedGroups(scannedThisRun);
        addFastScannedGroups(fastScannedThisRun);

        const stoppedDuringScan = batchStopRequested;
        stopBtn.style.display = 'none';

        const toRehostFinal = toRehost.slice(0, limit);
        statusEl.textContent = `Found ${toRehost.length} eligible groups (rehosting ${toRehostFinal.length}). ${skipped.ptpimg} ptpimg, ${skipped.alreadyRed} already on RED, ${skipped.noImage} no image.${stoppedDuringScan ? ' Stopped early.' : ''}`;
        foundCountEl.textContent = `${toRehost.length} found so far`;

        if (toRehostFinal.length === 0) {
            progressBar.style.width = '100%';
            startBtn.disabled = false;
            startBtn.textContent = 'Scan again';
            startBtn.onclick = triggerScan;
            updateProcessedCount();
            return;
        }

        resultsEl.innerHTML = toRehostFinal.map((item, idx) => {
            const parts = [];
            if (item.imageUrl) parts.push(`cover: ${escHtml(item.imageUrl)}`);
            if (item.alreadyHosted) parts.push(`cover: ${escHtml(item.alreadyHosted)} (recovered from RED cache)`);
            if (item.descImgUrls && item.descImgUrls.length) parts.push(`${item.descImgUrls.length} desc image(s)`);
            return `<div id="batch-row-${idx}" style="display:flex;align-items:center;gap:10px;padding:8px 12px;border-bottom:1px solid #222;font-size:12px;">
                <div style="flex:1;min-width:0;">
                    <a href="/torrents.php?id=${item.gid}" target="_blank" style="color:#4CAF50;text-decoration:none;">${escHtml(item.name)}</a>
                    <div style="color:#666;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${parts.join(' · ')}</div>
                </div>
                <span id="batch-status-${idx}" style="white-space:nowrap;color:#888;">queued</span>
            </div>`;
        }).join('');

        async function doRehostNow() {
            batchStopRequested = false;
            startBtn.disabled = true;
            startBtn.textContent = 'Rehosting…';
            stopBtn.style.display = 'inline-block'; stopBtn.disabled = false; stopBtn.textContent = 'Stop';

            let done = 0;
            for (let i = 0; i < toRehostFinal.length; i++) {
                if (batchStopRequested) break;
                const { gid, imageUrl, alreadyHosted, descImgUrls, bbBody, name } = toRehostFinal[i];
                const rowStatus = document.getElementById(`batch-status-${i}`);
                rowStatus.textContent = 'uploading…'; rowStatus.style.color = 'orange';
                progressBar.style.width = `${Math.round(50 + (i / toRehostFinal.length) * 50)}%`;
                statusEl.textContent = `Rehosting ${i + 1} of ${toRehostFinal.length}: ${name}`;

                try {
                    let postParams = []; let anyFailed = false;
                    if (alreadyHosted) {
                        postParams.push(`image=${encodeURIComponent(alreadyHosted)}`);
                    } else if (imageUrl) {
                        const newUrl = await batchUploadWithDeadSourceFallback(imageUrl, gid, apiKey);
                        if (newUrl) { postParams.push(`image=${encodeURIComponent(newUrl)}`); } else { anyFailed = true; }
                    }
                    if (descImgUrls && descImgUrls.length && bbBody) {
                        let updatedBody = bbBody;
                        for (const oldImgUrl of descImgUrls) {
                            const newImgUrl = await batchUploadImage(oldImgUrl, apiKey);
                            if (newImgUrl) { updatedBody = updatedBody.split(oldImgUrl).join(newImgUrl); } else { anyFailed = true; }
                        }
                        if (updatedBody !== bbBody) postParams.push(`body=${encodeURIComponent(updatedBody)}`);
                    }
                    if (postParams.length > 0) {
                        postParams.push(`summary=${encodeURIComponent('Cover rehosted to RED image host via CoverUp')}`);
                        await apiPost(`ajax.php?action=groupedit&id=${gid}`, apiKey, postParams.join('&'));
                        rowStatus.textContent = anyFailed ? '⚠ partial' : '✓ rehosted';
                        rowStatus.style.color  = anyFailed ? '#f59e0b' : '#4CAF50';
                        if (!anyFailed) { done++; addProcessedGroup(gid); }
                    } else {
                        rowStatus.textContent = '✗ upload failed'; rowStatus.style.color = '#ff4444';
                    }
                } catch(e) { rowStatus.textContent = '✗ error'; rowStatus.style.color = '#ff4444'; }
            }

            progressBar.style.width = '100%';
            statusEl.textContent = `Done! ${done} of ${toRehostFinal.length} rehosted. ${toRehostFinal.length - done} failed.${batchStopRequested ? ' Stopped early.' : ''}`;
            startBtn.disabled = false; startBtn.textContent = 'Scan again';
            startBtn.onclick = triggerScan;
            stopBtn.style.display = 'none';
            updateProcessedCount();
        }

        if (stoppedDuringScan) {
            startBtn.disabled = false;
            startBtn.textContent = `Rehost ${toRehostFinal.length} found so far`;
            startBtn.onclick = doRehostNow;
        } else {
            await doRehostNow();
        }
    }

    // ============================================================
    // --- PASTE-LIST BATCH (arbitrary group IDs — e.g. a forum thread's list) ---
    // ============================================================
    // Not tied to any particular page — reachable from the corner cluster on any
    // redacted.sh page. Built for one-off community lists like a forum post
    // enumerating groups whose cover art needs rehosting (e.g. after an external
    // image host used in descriptions/covers shuts down) — paste the IDs/URLs, or
    // even just the forum thread URL itself, and run the same search+rehost
    // pipeline as every other batch panel.
    function setupPasteListBatchPanel() {
        if (document.getElementById('nav_coverup_pastelist')) return;
        const apiKey = getRedApiKey();
        if (!apiKey) return;

        const cluster = getCoverupCornerCluster();

        const li = document.createElement('div');
        li.id = 'nav_coverup_pastelist';
        li.style.cssText = 'order:0.5;';
        const a = document.createElement('a');
        a.href = 'javascript:void(0)';
        a.textContent = '📋 Paste List';
        a.style.cssText = 'color:#4CAF50 !important;white-space:nowrap;cursor:pointer;font-size:12px;text-decoration:none;';
        li.appendChild(a);
        cluster.appendChild(li);

        const modal = document.createElement('div');
        modal.id = 'coverup-pastelist-modal';
        modal.style.cssText = 'display:none;position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:100003;background:#1a1a1a;border:2px solid #4CAF50;border-radius:10px;padding:20px;width:520px;max-width:92vw;max-height:85vh;overflow-y:auto;font-family:sans-serif;color:#fff;box-shadow:0 4px 24px rgba(0,0,0,0.8);';
        document.body.appendChild(modal);

        function renderModal() {
            modal.innerHTML = `
                <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
                    <div style="font-size:15px;font-weight:bold;color:#4CAF50;">🔴 CoverUp — Rehost a Pasted List of Groups</div>
                    <button id="pl-close" style="padding:6px 12px;background:#333;color:#aaa;border:none;border-radius:5px;cursor:pointer;font-size:12px;">✕</button>
                </div>
                <div style="background:#450a0a;border:1px solid #ef4444;border-radius:6px;padding:10px 12px;margin-bottom:10px;font-size:12px;color:#fca5a5;">
                    <strong>⚠ Use at your own risk.</strong> Batch mode automatically updates torrent group metadata — including releases you did not upload.
                </div>
                <div style="font-size:12px;color:#aaa;margin-bottom:6px;">
                    Paste group IDs, full torrents.php URLs (one per line or comma-separated), or a single RED forum thread URL — a struck-through/[s] entry in a forum post's list is treated as already done and skipped.
                </div>
                <textarea id="pl-input" placeholder="https://redacted.sh/torrents.php?id=12345&#10;12346&#10;12347&#10;&#10;— or —&#10;&#10;https://redacted.sh/forums.php?action=viewthread&amp;threadid=NNNN&amp;page=N#postNNNN" style="width:100%;height:110px;box-sizing:border-box;padding:8px;background:#111;border:1px solid #555;color:#fff;border-radius:5px;font-size:11px;font-family:monospace;margin-bottom:10px;resize:vertical;"></textarea>
                <div id="pl-parsed-count" style="font-size:11px;color:#666;margin-bottom:10px;"></div>
                <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:#aaa;margin-bottom:10px;cursor:pointer;">
                    <input type="checkbox" id="pl-reverse-order" checked>
                    Start from the bottom of the list and work up (handy when the top of a community list has already been picked over)
                </label>
                ${renderBatchRunModeSelector()}
                <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;">
                    <button id="batch-start" style="padding:9px 22px;background:#4CAF50;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:bold;font-size:14px;">Parse &amp; Scan</button>
                    <button id="batch-stop" style="display:none;padding:9px 18px;background:#555;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:bold;font-size:14px;">Stop</button>
                    <span id="batch-found-count" style="font-size:12px;color:#4CAF50;font-weight:bold;">0 found so far</span>
                </div>
                <div id="batch-status" style="font-size:12px;color:#aaa;margin-bottom:10px;">Paste a list above, then click Parse &amp; Scan.</div>
                <div id="batch-progress-bar-wrap" style="display:none;background:#333;border-radius:4px;height:8px;margin-bottom:12px;">
                    <div id="batch-progress-bar" style="background:#4CAF50;height:8px;border-radius:4px;width:0%;transition:width 0.3s;"></div>
                </div>
                <div id="batch-results" style="display:none;max-height:320px;overflow-y:auto;border:1px solid #333;border-radius:6px;"></div>
            `;

            wireBatchRunModeSelector(modal);
            modal.querySelector('#pl-close').onclick = () => { modal.style.display = 'none'; };

            const inputEl = modal.querySelector('#pl-input');
            const parsedCountEl = modal.querySelector('#pl-parsed-count');
            inputEl.addEventListener('input', () => {
                const ids = extractGroupIdsFromPastedText(inputEl.value);
                parsedCountEl.textContent = ids.length > 0 ? `${ids.length} group ID(s) recognised so far.` : '';
            });

            modal.querySelector('#batch-stop').onclick = () => {
                batchStopRequested = true;
                const stopBtn = modal.querySelector('#batch-stop');
                stopBtn.disabled = true;
                stopBtn.textContent = 'Stopping…';
            };

            async function triggerScan() {
                const raw = inputEl.value.trim();
                const statusEl = modal.querySelector('#batch-status');
                const startBtn = modal.querySelector('#batch-start');
                const isForumUrl = /^https?:\/\/redacted\.sh\/forums\.php\?/.test(raw) && !raw.includes('\n') && !raw.includes(',');

                let groupIds;
                if (isForumUrl) {
                    startBtn.disabled = true;
                    groupIds = await fetchGroupIdsFromForumUrl(raw, (msg) => { statusEl.textContent = msg; });
                    startBtn.disabled = false;
                    if (groupIds.length === 0) {
                        statusEl.textContent = '✗ Could not find any (non-struck-through) group links on that forum page.';
                        return;
                    }
                    statusEl.textContent = `Found ${groupIds.length} group(s) in the forum thread.`;
                } else {
                    groupIds = extractGroupIdsFromPastedText(raw);
                    if (groupIds.length === 0) {
                        statusEl.textContent = '✗ No group IDs or torrents.php URLs recognised in the pasted text.';
                        return;
                    }
                }

                const { limit, ptpimgOnlyMode } = getBatchRunMode(modal);
                const reverseOrder = modal.querySelector('#pl-reverse-order').checked;
                runPasteListBatch(groupIds, apiKey, limit, modal, refreshProcessedCountDisplay, () => triggerScan(), ptpimgOnlyMode, reverseOrder);
            }
            modal.querySelector('#batch-start').onclick = () => triggerScan();
        }

        a.onclick = () => {
            if (modal.style.display === 'block') { modal.style.display = 'none'; return; }
            renderModal();
            modal.style.display = 'block';
        };
    }

    async function runPasteListBatch(groupIds, apiKey, limit, panel, updateProcessedCount, triggerScan, ptpimgOnlyMode, reverseOrder) {
        const startBtn     = panel.querySelector('#batch-start');
        const stopBtn      = panel.querySelector('#batch-stop');
        const statusEl     = panel.querySelector('#batch-status');
        const foundCountEl = panel.querySelector('#batch-found-count');
        const progressWrap = panel.querySelector('#batch-progress-bar-wrap');
        const progressBar  = panel.querySelector('#batch-progress-bar');
        const resultsEl    = panel.querySelector('#batch-results');

        batchStopRequested = false;
        startBtn.disabled = true;
        startBtn.textContent = 'Scanning…';
        stopBtn.style.display = 'inline-block';
        stopBtn.disabled = false;
        stopBtn.textContent = 'Stop';
        progressWrap.style.display = 'block';
        resultsEl.style.display = 'block';
        resultsEl.innerHTML = '';
        foundCountEl.textContent = '0 found so far';

        // Dedup against the account-wide processed/scanned sets (shared with every
        // other panel) — a group already confirmed fine or rehosted elsewhere doesn't
        // need re-checking just because it also showed up in this pasted list.
        const processedGroups   = getProcessedGroups();
        const scannedGroups     = getScannedGroups();
        const fastScannedGroups = getFastScannedGroups();
        let uniqueIds = [...new Set(groupIds.map(String))];
        // Community lists like a forum thread's "missing covers" post tend to get
        // worked through from the top down, so the front of the list is often already
        // picked over by the time you get to it — starting from the bottom instead
        // means you hit unclaimed groups sooner.
        if (reverseOrder) uniqueIds = uniqueIds.slice().reverse();
        const unseenGroupIds = uniqueIds.filter(g => {
            if (processedGroups.has(g) || scannedGroups.has(g)) return false;
            if (ptpimgOnlyMode && fastScannedGroups.has(g)) return false;
            return true;
        });

        statusEl.textContent = `${uniqueIds.length} unique group(s) pasted (${unseenGroupIds.length} not yet checked elsewhere). Checking covers…`;

        const toRehost = [];
        const skipped = { ptpimg: 0, alreadyRed: 0, noImage: 0, gone: 0 };
        const scannedThisRun     = [];
        const fastScannedThisRun = [];
        let scanned = 0;
        const scanLimit = limit < Infinity ? Math.min(limit * 10, unseenGroupIds.length) : unseenGroupIds.length;

        for (let i = 0; i < scanLimit; i++) {
            if (batchStopRequested) break;
            if (limit < Infinity && toRehost.length >= limit) break;
            const gid = unseenGroupIds[i];
            scanned++;
            progressBar.style.width = `${Math.round((scanned / scanLimit) * 50)}%`;
            statusEl.textContent = `Checking group ${scanned} of ${scanLimit} (id ${gid})…`;
            foundCountEl.textContent = `${toRehost.length} found so far`;

            let queuedForRehost = false;
            let shallowSkip = false;

            const groupData = await apiGet(`ajax.php?action=torrentgroup&id=${gid}`, apiKey);
            if (!groupData || groupData.status !== 'success' || !groupData.response || !groupData.response.group) {
                // Group no longer exists (deleted/merged since the list was made) — skip.
                skipped.gone++;
                scannedThisRun.push(gid);
                continue;
            }
            const group  = groupData.response.group;
            const bbBody = group.bbBody || group.wikiBody || '';
            const name   = group.name || String(gid);
            const imageUrl = (group.wikiImage || '').trim();

            if (!imageUrl) {
                skipped.noImage++;
            } else {
                const h = (() => { try { return new URL(imageUrl).hostname.toLowerCase(); } catch(e) { return ''; } })();
                if (ptpimgOnlyMode && !h.includes('ptpimg.me')) {
                    shallowSkip = true;
                } else if (h.includes('redacted.sh') || h.includes('images.redacted.sh')) {
                    if (isRedThumbnailUrl(imageUrl)) {
                        toRehost.push({ gid, imageUrl: null, alreadyHosted: upgradeRedThumbnailUrl(imageUrl), descImgUrls: [], bbBody: null, name });
                        queuedForRehost = true;
                    } else {
                        skipped.alreadyRed++;
                    }
                } else if (h.includes('ptpimg.me')) {
                    statusEl.textContent = `Checking group ${scanned} of ${scanLimit} — ptpimg detected, trying RED cache…`;
                    const recoveredUrl = await uploadUrlToRed(imageUrl, apiKey);
                    if (recoveredUrl) {
                        toRehost.push({ gid, imageUrl: null, alreadyHosted: recoveredUrl, descImgUrls: [], bbBody: null, name });
                        queuedForRehost = true;
                    } else if (ptpimgOnlyMode) {
                        skipped.ptpimg++;
                        shallowSkip = true;
                    } else {
                        const sourceImageUrl = await new Promise(res => fetchGroupPageAndResolveImage(gid, bbBody, res));
                        if (sourceImageUrl) {
                            toRehost.push({ gid, imageUrl: sourceImageUrl, descImgUrls: [], bbBody: null, name, viaSources: true });
                            queuedForRehost = true;
                        } else {
                            skipped.ptpimg++;
                        }
                    }
                } else if (!ptpimgOnlyMode) {
                    // Deliberately NOT gated on needsBatchRehost()'s fixed domain
                    // allowlist — this panel exists specifically to handle arbitrary,
                    // possibly-unrecognised external hosts (e.g. Juno Download, which
                    // isn't and never needed to be in that list, and has since shut
                    // down entirely). Any non-RED, non-ptpimg host gets queued
                    // unconditionally; the actual upload step already tries the direct
                    // URL first via batchUploadWithDeadSourceFallback and only falls
                    // back to description-link/streaming search if that genuinely
                    // fails, so a still-working cover on some other host isn't wasted
                    // effort — it just re-uploads the same image to RED.
                    const descImgUrls = extractBBCodeImgUrls(bbBody).filter(needsDescriptionRehost);
                    toRehost.push({ gid, imageUrl, descImgUrls, bbBody: descImgUrls.length > 0 ? bbBody : null, name });
                    queuedForRehost = true;
                }
            }

            // Cover already looks fine (or the only problem is a dead ptpimg link with
            // no recoverable/source replacement) but there's still no usable image at
            // all here (e.g. imageUrl was empty) — fall back to a full deep search, same
            // as the missing-artwork panel, so a truly missing cover still gets found.
            if (!queuedForRehost && !imageUrl) {
                const links = bbBody ? extractSourceLinksFromBBCode(bbBody) : [];
                if (links.length) {
                    const sourceImageUrl = await new Promise(res => resolveFirstSourceImage(links, res));
                    if (sourceImageUrl) {
                        toRehost.push({ gid, imageUrl: sourceImageUrl, name, viaSources: true, descImgUrls: [], bbBody: null });
                        queuedForRehost = true;
                    }
                }
                if (!queuedForRehost && !ptpimgOnlyMode) {
                    const artist = (group.musicInfo && group.musicInfo.artists && group.musicInfo.artists[0]) ? group.musicInfo.artists[0].name : '';
                    const albumInfo = { artist, album: group.name || String(gid), year: String(group.year || '') };
                    const candidates = await new Promise(res => searchStreamingForApproval(albumInfo, res));
                    if (candidates && candidates.length > 0) {
                        toRehost.push({ gid, imageUrl: null, name, needsApproval: true, candidates, albumInfo, descImgUrls: [], bbBody: null });
                        queuedForRehost = true;
                    }
                } else if (!queuedForRehost && ptpimgOnlyMode) {
                    shallowSkip = true;
                }
            }

            if (!queuedForRehost) {
                if (shallowSkip) { fastScannedThisRun.push(gid); }
                else { scannedThisRun.push(gid); }
            }
        }

        addScannedGroups(scannedThisRun);
        addFastScannedGroups(fastScannedThisRun);

        const stoppedDuringScan = batchStopRequested;
        stopBtn.style.display = 'none';

        const toRehostFinal = toRehost.slice(0, limit);
        statusEl.textContent = `Found ${toRehost.length} eligible groups (${toRehostFinal.length} queued). ${skipped.ptpimg} ptpimg, ${skipped.alreadyRed} already on RED, ${skipped.noImage} no image, ${skipped.gone} no longer exist.${stoppedDuringScan ? ' Stopped early.' : ''}`;
        foundCountEl.textContent = `${toRehost.length} found so far`;

        if (toRehostFinal.length === 0) {
            progressBar.style.width = '100%';
            startBtn.disabled = false;
            startBtn.textContent = 'Scan again';
            startBtn.onclick = () => triggerScan();
            updateProcessedCount();
            return;
        }

        resultsEl.innerHTML = toRehostFinal.map((item, idx) => {
            if (item.needsApproval) {
                const thumbs = item.candidates.map((c, ci) =>
                    `<div style="display:inline-block;margin:4px;text-align:center;vertical-align:top;width:100px;">
                        <img src="${escHtml(c.imageUrl)}" style="width:100px;height:100px;object-fit:contain;background:#111;border-radius:4px;border:2px solid #333;cursor:pointer;" data-idx="${idx}" data-ci="${ci}" class="approval-thumb">
                        <div style="font-size:9px;color:#666;margin-top:2px;">${escHtml(c.searchSource)}</div>
                        <button class="approval-btn" data-idx="${idx}" data-ci="${ci}" style="margin-top:3px;padding:3px 8px;background:#4CAF50;color:#fff;border:none;border-radius:3px;cursor:pointer;font-size:10px;">✓ Use</button>
                    </div>`
                ).join('');
                return `<div id="batch-row-${idx}" style="padding:10px 12px;border-bottom:1px solid #222;font-size:12px;">
                    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
                        <a href="/torrents.php?id=${item.gid}" target="_blank" style="color:#4CAF50;text-decoration:none;font-weight:bold;">${escHtml(item.name)}</a>
                        <span style="display:flex;align-items:center;gap:6px;">
                            <span id="batch-status-${idx}" style="white-space:nowrap;color:#f59e0b;font-size:11px;">awaiting approval</span>
                            <button class="approval-skip" data-idx="${idx}" style="padding:3px 8px;background:#333;color:#aaa;border:none;border-radius:3px;cursor:pointer;font-size:10px;">✗ Skip</button>
                        </span>
                    </div>
                    <div style="font-size:10px;color:#666;margin-bottom:6px;">No embedded links found — streaming search results (${item.candidates.length} candidates):</div>
                    <div>${thumbs}</div>
                </div>`;
            }
            const parts = [];
            if (item.imageUrl) parts.push(`cover: ${escHtml(item.imageUrl)}`);
            if (item.alreadyHosted) parts.push(`cover: ${escHtml(item.alreadyHosted)} (recovered from RED cache)`);
            if (item.descImgUrls && item.descImgUrls.length) parts.push(`${item.descImgUrls.length} desc image(s)`);
            return `<div id="batch-row-${idx}" style="display:flex;align-items:center;gap:10px;padding:8px 12px;border-bottom:1px solid #222;font-size:12px;">
                <div style="flex:1;min-width:0;">
                    <a href="/torrents.php?id=${item.gid}" target="_blank" style="color:#4CAF50;text-decoration:none;">${escHtml(item.name)}</a>
                    <div style="color:#666;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${parts.join(' · ')}</div>
                </div>
                <span id="batch-status-${idx}" style="white-space:nowrap;color:#888;">queued</span>
            </div>`;
        }).join('');

        resultsEl.querySelectorAll('.approval-btn').forEach(btn => {
            btn.onclick = () => {
                const idx = parseInt(btn.dataset.idx);
                const ci  = parseInt(btn.dataset.ci);
                const item = toRehostFinal[idx];
                item.imageUrl = item.candidates[ci].imageUrl;
                item.approved = true;
                const row = document.getElementById(`batch-row-${idx}`);
                const statusEl2 = document.getElementById(`batch-status-${idx}`);
                statusEl2.textContent = 'approved — queued';
                statusEl2.style.color = '#4CAF50';
                row.querySelectorAll('.approval-thumb').forEach((t, ti) => {
                    t.style.borderColor = ti === ci ? '#4CAF50' : '#222';
                    t.style.opacity = ti === ci ? '1' : '0.4';
                });
                row.querySelectorAll('.approval-btn').forEach(b => b.style.display = 'none');
                row.querySelector('.approval-skip').style.display = 'none';
            };
        });
        resultsEl.querySelectorAll('.approval-skip').forEach(btn => {
            btn.onclick = () => {
                const idx = parseInt(btn.dataset.idx);
                toRehostFinal[idx].skipped = true;
                const statusEl2 = document.getElementById(`batch-status-${idx}`);
                statusEl2.textContent = 'skipped';
                statusEl2.style.color = '#555';
            };
        });

        async function doRehostNow() {
            batchStopRequested = false;
            startBtn.disabled = true;
            startBtn.textContent = 'Rehosting…';
            stopBtn.style.display = 'inline-block'; stopBtn.disabled = false; stopBtn.textContent = 'Stop';

            let done = 0;
            for (let i = 0; i < toRehostFinal.length; i++) {
                if (batchStopRequested) break;
                const item = toRehostFinal[i];
                if (item.skipped) continue;
                if (item.needsApproval && !item.approved) continue;
                const { gid, imageUrl, alreadyHosted, descImgUrls, bbBody, name } = item;
                const rowStatus = document.getElementById(`batch-status-${i}`);
                rowStatus.textContent = 'uploading…'; rowStatus.style.color = 'orange';
                progressBar.style.width = `${Math.round(50 + (i / toRehostFinal.length) * 50)}%`;
                statusEl.textContent = `Rehosting ${i + 1} of ${toRehostFinal.length}: ${name}`;

                try {
                    let postParams = []; let anyFailed = false;
                    if (alreadyHosted) {
                        postParams.push(`image=${encodeURIComponent(alreadyHosted)}`);
                    } else if (imageUrl) {
                        const newUrl = await batchUploadWithDeadSourceFallback(imageUrl, gid, apiKey);
                        if (newUrl) { postParams.push(`image=${encodeURIComponent(newUrl)}`); } else { anyFailed = true; }
                    }
                    if (descImgUrls && descImgUrls.length && bbBody) {
                        let updatedBody = bbBody;
                        for (const oldImgUrl of descImgUrls) {
                            const newImgUrl = await batchUploadImage(oldImgUrl, apiKey);
                            if (newImgUrl) { updatedBody = updatedBody.split(oldImgUrl).join(newImgUrl); } else { anyFailed = true; }
                        }
                        if (updatedBody !== bbBody) postParams.push(`body=${encodeURIComponent(updatedBody)}`);
                    }
                    if (postParams.length > 0) {
                        postParams.push(`summary=${encodeURIComponent('Cover rehosted to RED image host via CoverUp')}`);
                        await apiPost(`ajax.php?action=groupedit&id=${gid}`, apiKey, postParams.join('&'));
                        rowStatus.textContent = anyFailed ? '⚠ partial' : '✓ rehosted';
                        rowStatus.style.color  = anyFailed ? '#f59e0b' : '#4CAF50';
                        if (!anyFailed) { done++; addProcessedGroup(gid); }
                    } else {
                        rowStatus.textContent = '✗ upload failed'; rowStatus.style.color = '#ff4444';
                    }
                } catch(e) { rowStatus.textContent = '✗ error'; rowStatus.style.color = '#ff4444'; }
            }

            progressBar.style.width = '100%';
            statusEl.textContent = `Done! ${done} of ${toRehostFinal.length} rehosted. ${toRehostFinal.length - done} failed.${batchStopRequested ? ' Stopped early.' : ''}`;
            startBtn.disabled = false; startBtn.textContent = 'Scan again';
            startBtn.onclick = () => triggerScan();
            stopBtn.style.display = 'none';
            updateProcessedCount();
        }

        const hasApprovalItems = toRehostFinal.some(i => i.needsApproval);
        startBtn.disabled = false;
        startBtn.textContent = hasApprovalItems ? 'Done — Start Rehosting (approve thumbnails below first)' : 'Done — Start Rehosting';
        startBtn.onclick = doRehostNow;
    }

    function setupArtistBatchPanel() {
        // Only on artist.php?id=X
        const artistIdMatch = window.location.search.match(/[?&]id=(\d+)/);
        if (!artistIdMatch || !/artist\.php/.test(window.location.pathname)) return;

        const apiKey = getRedApiKey();
        if (!apiKey) return;

        const artistId = artistIdMatch[1];

        const panel = document.createElement('div');
        panel.id = 'coverup-batch-panel';
        panel.style.cssText = 'background:#1a1a1a;border:2px solid #4CAF50;border-radius:10px;padding:20px;margin:16px 0;font-family:sans-serif;color:#fff;';
        panel.innerHTML = `
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">
                <div style="font-size:16px;font-weight:bold;color:#4CAF50;">🔴 CoverUp — Batch Rehost This Artist's Releases</div>
                <div style="display:flex;align-items:center;gap:8px;">
                    <button id="batch-start" style="padding:9px 22px;background:#4CAF50;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:bold;font-size:14px;">Scan releases</button>
                    <button id="batch-stop" style="display:none;padding:9px 18px;background:#555;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:bold;font-size:14px;">Stop</button>
                    <button id="batch-panel-toggle" title="Hide the whole batch panel" style="padding:9px 18px;background:#555;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:bold;font-size:14px;flex-shrink:0;">Hide</button>
                </div>
            </div>
            <div id="batch-panel-body">
            <div style="background:#450a0a;border:1px solid #ef4444;border-radius:6px;padding:10px 12px;margin-bottom:10px;font-size:12px;color:#fca5a5;">
                <strong>⚠ Use at your own risk.</strong> Batch mode automatically updates torrent group metadata — including releases you did not upload.
                Test with a small number first and check results manually.
            </div>
            <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:10px;">
                <div id="batch-status" style="font-size:13px;color:#aaa;flex:1;">
                    Scans all releases by this artist for covers that need rehosting to RED's image host.
                </div>
                <span id="batch-found-count" style="font-size:12px;color:#4CAF50;font-weight:bold;white-space:nowrap;">0 found so far</span>
            </div>
            ${renderBatchRunModeSelector()}
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;font-size:12px;color:#666;">
                <span id="batch-processed-count"></span>
                <a href="javascript:void(0)" id="batch-reset-page-processed" style="color:#555;text-decoration:underline;">Reset progress for this artist only</a>
                <a href="javascript:void(0)" id="batch-reset-processed" style="color:#555;text-decoration:underline;">Reset all progress</a>
            </div>
            <div id="batch-progress-bar-wrap" style="display:none;background:#333;border-radius:4px;height:8px;margin-bottom:12px;">
                <div id="batch-progress-bar" style="background:#4CAF50;height:8px;border-radius:4px;width:0%;transition:width 0.3s;"></div>
            </div>
            <div id="batch-results" style="display:none;max-height:400px;overflow-y:auto;border:1px solid #333;border-radius:6px;"></div>
            </div>`;

        const target = document.querySelector('.thin') || document.querySelector('#content');
        if (target) target.prepend(panel);
        else document.body.prepend(panel);

        setupBatchPanelCollapse(panel);
        wireBatchRunModeSelector(panel);
        refreshProcessedCountDisplay();

        panel.querySelector('#batch-reset-page-processed').onclick = async () => {
            if (!confirm('Re-check every release by this artist from scratch? Groups already confirmed fine or rehosted elsewhere are unaffected.')) return;
            const link = panel.querySelector('#batch-reset-page-processed');
            const prevText = link.textContent;
            link.textContent = 'Fetching list…';
            const groupInfo = await fetchArtistGroupIds(artistId, apiKey, panel.querySelector('#batch-status'));
            const affected = removeGroupsFromProgress([...groupInfo.keys()]);
            link.textContent = prevText;
            refreshProcessedCountDisplay();
            alert(`Cleared ${affected} group(s) — they'll be re-checked on the next scan.`);
        };

        panel.querySelector('#batch-reset-processed').onclick = () => {
            if (confirm('Clear saved scan progress? All groups will be checked again from scratch next run.\n\n(Your all-time rehosted count is not affected.)')) {
                clearProcessedGroups();
                clearScannedGroups();
                clearFastScannedGroups();
                refreshProcessedCountDisplay();
            }
        };

        panel.querySelector('#batch-stop').onclick = () => {
            batchStopRequested = true;
            const stopBtn = panel.querySelector('#batch-stop');
            stopBtn.disabled = true;
            stopBtn.textContent = 'Stopping…';
        };

        function triggerScan() {
            const { limit, ptpimgOnlyMode } = getBatchRunMode(panel);
            runArtistBatch(artistId, apiKey, limit, panel, refreshProcessedCountDisplay, triggerScan, ptpimgOnlyMode);
        }
        panel.querySelector('#batch-start').onclick = triggerScan;
    }

    // Fetches every release-group ID for a given artist. Gazelle's action=artist
    // response nests releases under response.torrentgroup, each entry carrying a
    // groupId — falls back defensively across a couple of plausible field-name
    // variants and logs once if the shape is unrecognized.
    // Gazelle's action=artist response already includes each release's wikiImage
    // (and name) alongside its groupId — return that too instead of discarding it,
    // so the scan loop can classify covers without a separate per-group API call.
    async function fetchArtistGroupIds(artistId, apiKey, statusEl) {
        const groups = new Map();
        const data = await apiGet(`ajax.php?action=artist&id=${artistId}`, apiKey);
        if (!data || data.status !== 'success' || !data.response) return groups;

        const list = data.response.torrentgroup || data.response.torrentGroups || data.response.groups || [];
        if (Array.isArray(list)) {
            let loggedUnknownShape = false;
            list.forEach(g => {
                const gid = g.groupId ?? g.groupID ?? g.id ?? null;
                if (gid != null) {
                    groups.set(String(gid), { wikiImage: (g.wikiImage || '').trim(), name: g.groupName || g.name || String(gid) });
                } else if (!loggedUnknownShape) {
                    console.warn('[CoverUp] Unexpected artist torrentgroup entry shape — no groupId found:', g);
                    loggedUnknownShape = true;
                }
            });
        } else {
            console.warn('[CoverUp] Unexpected artist API response shape — no torrentgroup array found:', data.response);
        }

        statusEl.textContent = `Found ${groups.size} releases by this artist…`;
        return groups;
    }

    async function runArtistBatch(artistId, apiKey, limit, panel, updateProcessedCount, triggerScan, ptpimgOnlyMode = false) {
        const startBtn     = panel.querySelector('#batch-start');
        const stopBtn      = panel.querySelector('#batch-stop');
        const statusEl     = panel.querySelector('#batch-status');
        const foundCountEl = panel.querySelector('#batch-found-count');
        const progressWrap = panel.querySelector('#batch-progress-bar-wrap');
        const progressBar  = panel.querySelector('#batch-progress-bar');
        const resultsEl    = panel.querySelector('#batch-results');

        batchStopRequested = false;
        startBtn.disabled = true;
        startBtn.textContent = 'Scanning…';
        stopBtn.style.display = 'inline-block';
        stopBtn.disabled = false;
        stopBtn.textContent = 'Stop';
        progressWrap.style.display = 'block';
        resultsEl.style.display = 'block';
        resultsEl.innerHTML = '';
        foundCountEl.textContent = '0 found so far';

        statusEl.textContent = 'Fetching this artist\'s releases…';
        const groupInfo = await fetchArtistGroupIds(artistId, apiKey, statusEl);
        const allGroupIds = [...groupInfo.keys()];

        const processedGroups   = getProcessedGroups();
        const scannedGroups     = getScannedGroups();
        const fastScannedGroups = getFastScannedGroups();
        const unseenGroupIds = allGroupIds.filter(g => {
            const key = String(g);
            if (processedGroups.has(key) || scannedGroups.has(key)) return false;
            if (ptpimgOnlyMode && fastScannedGroups.has(key)) return false;
            return true;
        });
        const groupIds = [...unseenGroupIds].sort(() => Math.random() - 0.5);

        statusEl.textContent = `Found ${allGroupIds.length} releases by this artist (${groupIds.length} not yet checked). Checking covers…`;

        const toRehost = [];
        const skipped  = { ptpimg: 0, alreadyRed: 0, noImage: 0 };
        const scannedThisRun     = [];
        const fastScannedThisRun = [];
        let scanned = 0;
        const scanLimit = limit < Infinity ? Math.min(limit * 10, groupIds.length) : groupIds.length;

        for (let i = 0; i < scanLimit; i++) {
            if (batchStopRequested) break;
            if (limit < Infinity && toRehost.length >= limit) break;
            const gid = groupIds[i];
            scanned++;
            progressBar.style.width = `${Math.round((scanned / scanLimit) * 50)}%`;
            statusEl.textContent = `Checking release ${scanned} of ${scanLimit}…`;
            foundCountEl.textContent = `${toRehost.length} found so far`;

            // Cover host is already known from the bulk artist fetch — classify it
            // for free, with zero API calls, before ever touching torrentgroup.
            const info     = groupInfo.get(String(gid));
            const imageUrl = info ? info.wikiImage : '';
            const name     = (info && info.name) || gid;

            let coverNeedsRehost = false;
            let queuedForRehost  = false;
            // Fast Mode only ever performs a shallow, partial check (ptpimg cache only) —
            // when it gives up on a group for that reason, that's not a real verdict, so
            // the group must stay eligible for a later Deep Mode run.
            let shallowSkip = false;
            if (!imageUrl) { skipped.noImage++; }
            else {
                const h = (() => { try { return new URL(imageUrl).hostname.toLowerCase(); } catch(e) { return ''; } })();
                if (ptpimgOnlyMode && !h.includes('ptpimg.me')) {
                    // ptpimg-only mode: ignore every other category for speed —
                    // don't mark scanned, since we never actually evaluated it.
                    shallowSkip = true;
                } else if (h.includes('redacted.sh') || h.includes('images.redacted.sh')) {
                    if (isRedThumbnailUrl(imageUrl)) {
                        toRehost.push({ gid, imageUrl: null, alreadyHosted: upgradeRedThumbnailUrl(imageUrl), descImgUrls: [], bbBody: null, name });
                        queuedForRehost = true;
                    } else {
                        skipped.alreadyRed++;
                    }
                } else if (h.includes('ptpimg.me')) {
                    statusEl.textContent = `Checking release ${scanned} of ${scanLimit} — ptpimg detected, trying RED cache…`;
                    const recoveredUrl = await uploadUrlToRed(imageUrl, apiKey);
                    if (recoveredUrl) {
                        toRehost.push({ gid, imageUrl: null, alreadyHosted: recoveredUrl, descImgUrls: [], bbBody: null, name });
                        queuedForRehost = true;
                    } else if (ptpimgOnlyMode) {
                        // Shallow check (cache only) — don't mark scanned.
                        skipped.ptpimg++;
                        shallowSkip = true;
                    } else {
                        statusEl.textContent = `Checking release ${scanned} of ${scanLimit} — checking source links…`;
                        const sourceImageUrl = await new Promise(res => fetchGroupPageAndResolveImage(gid, '', res));
                        if (sourceImageUrl) {
                            toRehost.push({ gid, imageUrl: sourceImageUrl, descImgUrls: [], bbBody: null, name, viaSources: true });
                            queuedForRehost = true;
                        } else {
                            skipped.ptpimg++;
                        }
                    }
                } else if (!ptpimgOnlyMode && needsBatchRehost(imageUrl)) {
                    coverNeedsRehost = true;
                }
            }

            // Only groups whose cover actually needs rehosting pay for the extra
            // torrentgroup API call (to grab bbBody for description-image handling).
            // Clean-cover groups above never reach here — that's the whole speedup:
            // no per-group call at all for the common case of an already-fine cover.
            if (coverNeedsRehost && !queuedForRehost) {
                const groupData = await apiGet(`ajax.php?action=torrentgroup&id=${gid}`, apiKey);
                if (!groupData || groupData.status !== 'success') continue;
                const group  = groupData.response.group;
                const bbBody = group.bbBody || group.wikiBody || '';
                const descImgUrls = extractBBCodeImgUrls(bbBody).filter(needsDescriptionRehost);
                toRehost.push({ gid, imageUrl, descImgUrls, bbBody: descImgUrls.length > 0 ? bbBody : null, name: group.name || name });
                queuedForRehost = true;
            }

            if (!queuedForRehost) {
                if (shallowSkip) {
                    fastScannedThisRun.push(gid);
                } else {
                    scannedThisRun.push(gid);
                }
            }
        }

        addScannedGroups(scannedThisRun);
        addFastScannedGroups(fastScannedThisRun);

        const stoppedDuringScan = batchStopRequested;
        stopBtn.style.display = 'none';

        const toRehostFinal = toRehost.slice(0, limit);
        statusEl.textContent = `Found ${toRehost.length} eligible releases (rehosting ${toRehostFinal.length}). ${skipped.ptpimg} ptpimg, ${skipped.alreadyRed} already on RED, ${skipped.noImage} no image.${stoppedDuringScan ? ' Stopped early.' : ''}`;
        foundCountEl.textContent = `${toRehost.length} found so far`;

        if (toRehostFinal.length === 0) {
            progressBar.style.width = '100%';
            startBtn.disabled = false;
            startBtn.textContent = 'Scan again';
            startBtn.onclick = triggerScan;
            updateProcessedCount();
            return;
        }

        resultsEl.innerHTML = toRehostFinal.map((item, idx) => {
            const parts = [];
            if (item.imageUrl) parts.push(`cover: ${escHtml(item.imageUrl)}`);
            if (item.alreadyHosted) parts.push(`cover: ${escHtml(item.alreadyHosted)} (recovered from RED cache)`);
            if (item.descImgUrls && item.descImgUrls.length) parts.push(`${item.descImgUrls.length} desc image(s)`);
            return `<div id="batch-row-${idx}" style="display:flex;align-items:center;gap:10px;padding:8px 12px;border-bottom:1px solid #222;font-size:12px;">
                <div style="flex:1;min-width:0;">
                    <a href="/torrents.php?id=${item.gid}" target="_blank" style="color:#4CAF50;text-decoration:none;">${escHtml(item.name)}</a>
                    <div style="color:#666;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${parts.join(' · ')}</div>
                </div>
                <span id="batch-status-${idx}" style="white-space:nowrap;color:#888;">queued</span>
            </div>`;
        }).join('');

        async function doRehostNow() {
            batchStopRequested = false;
            startBtn.disabled = true;
            startBtn.textContent = 'Rehosting…';
            stopBtn.style.display = 'inline-block'; stopBtn.disabled = false; stopBtn.textContent = 'Stop';

            let done = 0;
            for (let i = 0; i < toRehostFinal.length; i++) {
                if (batchStopRequested) break;
                const { gid, imageUrl, alreadyHosted, descImgUrls, bbBody, name } = toRehostFinal[i];
                const rowStatus = document.getElementById(`batch-status-${i}`);
                rowStatus.textContent = 'uploading…'; rowStatus.style.color = 'orange';
                progressBar.style.width = `${Math.round(50 + (i / toRehostFinal.length) * 50)}%`;
                statusEl.textContent = `Rehosting ${i + 1} of ${toRehostFinal.length}: ${name}`;

                try {
                    let postParams = []; let anyFailed = false;
                    if (alreadyHosted) {
                        postParams.push(`image=${encodeURIComponent(alreadyHosted)}`);
                    } else if (imageUrl) {
                        const newUrl = await batchUploadWithDeadSourceFallback(imageUrl, gid, apiKey);
                        if (newUrl) { postParams.push(`image=${encodeURIComponent(newUrl)}`); } else { anyFailed = true; }
                    }
                    if (descImgUrls && descImgUrls.length && bbBody) {
                        let updatedBody = bbBody;
                        for (const oldImgUrl of descImgUrls) {
                            const newImgUrl = await batchUploadImage(oldImgUrl, apiKey);
                            if (newImgUrl) { updatedBody = updatedBody.split(oldImgUrl).join(newImgUrl); } else { anyFailed = true; }
                        }
                        if (updatedBody !== bbBody) postParams.push(`body=${encodeURIComponent(updatedBody)}`);
                    }
                    if (postParams.length > 0) {
                        postParams.push(`summary=${encodeURIComponent('Cover rehosted to RED image host via CoverUp')}`);
                        await apiPost(`ajax.php?action=groupedit&id=${gid}`, apiKey, postParams.join('&'));
                        rowStatus.textContent = anyFailed ? '⚠ partial' : '✓ rehosted';
                        rowStatus.style.color  = anyFailed ? '#f59e0b' : '#4CAF50';
                        if (!anyFailed) { done++; addProcessedGroup(gid); }
                    } else {
                        rowStatus.textContent = '✗ upload failed'; rowStatus.style.color = '#ff4444';
                    }
                } catch(e) { rowStatus.textContent = '✗ error'; rowStatus.style.color = '#ff4444'; }
            }

            progressBar.style.width = '100%';
            statusEl.textContent = `Done! ${done} of ${toRehostFinal.length} rehosted. ${toRehostFinal.length - done} failed.${batchStopRequested ? ' Stopped early.' : ''}`;
            startBtn.disabled = false; startBtn.textContent = 'Scan again';
            startBtn.onclick = triggerScan;
            stopBtn.style.display = 'none';
            updateProcessedCount();
        }

        if (stoppedDuringScan) {
            startBtn.disabled = false;
            startBtn.textContent = `Rehost ${toRehostFinal.length} found so far`;
            startBtn.onclick = doRehostNow;
        } else {
            await doRehostNow();
        }
    }

    (function addReCoverNavButton() {
        // Only run once — guard against duplicate injection
        if (document.getElementById('nav_coverup_settings')) return;
        // Rendered as rows inside the shared bottom-right corner cluster, rather than
        // as its own separate floating box.
        const cluster = getCoverupCornerCluster();

        // --- ⚙ CoverUp Settings button ---
        const settingsLi = document.createElement('div');
        settingsLi.id = 'nav_coverup_settings';
        settingsLi.style.cssText = 'order:1;';
        const settingsA = document.createElement('a');
        settingsA.href = 'javascript:void(0)';
        settingsA.textContent = '⚙ CoverUp Settings';
        settingsA.style.cssText = 'color:#4CAF50 !important;white-space:nowrap;cursor:pointer;font-size:12px;text-decoration:none;';
        settingsLi.appendChild(settingsA);
        cluster.appendChild(settingsLi);

        // Add a small toggle dot to hide/show the settings button
        const BTNS_HIDDEN_KEY = 'coverup_buttons_hidden';
        const dot = document.createElement('div');
        dot.id = 'coverup-btn-toggle';
        dot.style.cssText = 'order:2;display:flex;align-items:center;gap:6px;cursor:pointer;opacity:0.85;';
        dot.title = 'CoverUp — click to hide/show buttons';
        dot.innerHTML = '<span id="coverup-btn-dot" style="width:10px;height:10px;border-radius:50%;background:#4CAF50;flex-shrink:0;display:inline-block;"></span><span style="font-size:10px;color:#4CAF50;white-space:nowrap;">Hide/Reveal CoverUp</span>';
        cluster.appendChild(dot);

        function applyBtnVisibility(hidden) {
            settingsLi.style.display = hidden ? 'none' : '';
            const innerDot = document.getElementById('coverup-btn-dot');
            if (innerDot) innerDot.style.background = hidden ? '#ff4444' : '#4CAF50';
            const label = dot.querySelector('span:last-child');
            if (label) { label.textContent = hidden ? 'CoverUp Settings' : 'Hide'; label.style.color = hidden ? '#ff4444' : '#4CAF50'; }
        }

        applyBtnVisibility(GM_getValue(BTNS_HIDDEN_KEY, false));

        dot.onclick = () => {
            const nowHidden = !GM_getValue(BTNS_HIDDEN_KEY, false);
            GM_setValue(BTNS_HIDDEN_KEY, nowHidden);
            applyBtnVisibility(nowHidden);
        };

        const pop = document.createElement('div');
        pop.style.cssText = 'display:none;position:fixed;top:60px;right:20px;z-index:100002;background:#1a1a1a;border:2px solid #4CAF50;border-radius:10px;padding:18px;width:340px;font-family:sans-serif;color:#fff;box-shadow:0 4px 20px rgba(0,0,0,0.7);';
        document.body.appendChild(pop);

        pop.style.display = 'none'; // ensure initial state is explicitly set
        settingsA.onclick = (e) => {
            e.stopPropagation();
            e.preventDefault();
            if (pop.style.display === 'block') { pop.style.display = 'none'; return; }
            try {
            pop.innerHTML = `
                <div style="font-weight:bold;color:#4CAF50;margin-bottom:6px;font-size:14px;">⚙ CoverUp Settings</div>
                <div style="font-size:10px;color:#666;margin-bottom:12px;">Use CoverUp in one browser tab at a time — running batches in multiple tabs at once can exceed RED's API rate limit.</div>

                <div style="font-size:12px;color:#aaa;margin-bottom:4px;">RED API Key <span style="color:#4CAF50;">(primary host)</span></div>
                <div style="font-size:11px;color:#666;margin-bottom:6px;">RED → Settings → API Keys → User + Torrents scopes</div>
                <div style="display:flex;gap:6px;margin-bottom:14px;">
                    <input id="sp-red-key" type="password" placeholder="Paste RED API key…" value="${getRedApiKey()}"
                        style="flex:1;padding:7px 9px;background:#111;border:1px solid #555;color:#fff;border-radius:5px;font-size:12px;font-family:monospace;box-sizing:border-box;">
                    <button id="sp-red-save" style="padding:7px 14px;background:#4CAF50;color:#fff;border:none;border-radius:5px;cursor:pointer;font-weight:bold;white-space:nowrap;">Save</button>
                </div>

                <div style="font-size:12px;color:#aaa;margin-bottom:6px;">Fallback host</div>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:8px;">
                    <button class="sp-fb" data-host="catbox" style="padding:7px;background:#222;border:1px solid ${getPreferredFallbackHost()==='catbox'?'#4CAF50':'#555'};border-radius:5px;color:#fff;cursor:pointer;font-size:12px;">catbox<br><span style="font-size:10px;color:#888;">no key needed</span></button>
                    <button class="sp-fb" data-host="imgbb" style="padding:7px;background:#222;border:1px solid ${getPreferredFallbackHost()==='imgbb'?'#4CAF50':'#555'};border-radius:5px;color:#fff;cursor:pointer;font-size:12px;">imgbb<br><span style="font-size:10px;color:#888;">requires key</span></button>
                </div>
                <div style="font-size:11px;color:#666;margin-bottom:4px;">imgbb API key</div>
                <input id="sp-imgbb-key" type="password" placeholder="imgbb API key…" value="${getImgbbKey()}"
                    style="width:100%;padding:6px 8px;background:#111;border:1px solid #555;color:#fff;border-radius:4px;font-size:11px;font-family:monospace;box-sizing:border-box;margin-bottom:6px;">
                <div style="font-size:11px;color:#666;margin-bottom:4px;">TheSunGod API key</div>
                <div style="display:flex;gap:6px;margin-bottom:14px;">
                    <input id="sp-sungod-key" type="password" placeholder="TheSunGod API key…" value="${getSungodKey()}"
                        style="flex:1;padding:6px 8px;background:#111;border:1px solid #555;color:#fff;border-radius:4px;font-size:11px;font-family:monospace;box-sizing:border-box;">
                    <button class="sp-fb" data-host="sungod" style="padding:6px 10px;background:#222;border:1px solid ${getPreferredFallbackHost()==='sungod'?'#4CAF50':'#555'};border-radius:4px;color:#fff;cursor:pointer;font-size:11px;white-space:nowrap;">Use SunGod</button>
                </div>

                <div style="font-size:11px;color:#666;margin-bottom:5px;">Discogs token (for artwork search)</div>
                <div style="display:flex;gap:6px;margin-bottom:14px;">
                    <input id="sp-discogs-token" type="password" placeholder="Discogs personal access token…" value="${getDiscogsToken()}"
                        style="flex:1;padding:6px 8px;background:#111;border:1px solid #555;color:#fff;border-radius:4px;font-size:11px;font-family:monospace;box-sizing:border-box;">
                    <button id="sp-discogs-save" style="padding:6px 10px;background:#7B1FA2;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:11px;white-space:nowrap;">Save</button>
                </div>

                <div style="display:flex;justify-content:space-between;align-items:center;">
                    <span id="sp-status" style="font-size:11px;color:#4CAF50;"></span>
                    <button id="sp-close" style="padding:6px 12px;background:#333;color:#aaa;border:none;border-radius:5px;cursor:pointer;font-size:12px;">Close</button>
                </div>`;

            const status = pop.querySelector('#sp-status');
            pop.querySelector('#sp-red-save').onclick = () => {
                const k = pop.querySelector('#sp-red-key').value.trim();
                if (k) { setRedApiKey(k); status.textContent = '✓ RED key saved'; }
            };
            pop.querySelector('#sp-discogs-save').onclick = () => {
                const t = pop.querySelector('#sp-discogs-token').value.trim();
                if (t) { setDiscogsToken(t); status.textContent = '✓ Discogs token saved'; }
            };
            pop.querySelectorAll('.sp-fb').forEach(b => {
                b.onclick = () => {
                    const host = b.dataset.host;
                    if (host === 'imgbb')  { const k = pop.querySelector('#sp-imgbb-key').value.trim();  if (k) setImgbbKey(k); }
                    if (host === 'sungod') { const k = pop.querySelector('#sp-sungod-key').value.trim(); if (k) setSungodKey(k); }
                    setPreferredFallbackHost(host);
                    status.textContent = `✓ Fallback set to ${host}`;
                };
            });
            pop.querySelector('#sp-close').onclick = () => { pop.style.display = 'none'; };
            } catch(err) { console.error('[CoverUp] Settings pop error:', err); return; }
            setTimeout(() => { pop.style.display = 'block'; }, 0);
        };

        document.addEventListener('click', (e) => {
            if (!settingsLi.contains(e.target) && !pop.contains(e.target)) pop.style.display = 'none';
        });
    })();



    // ============================================================
    // --- BROWSE/SEARCH RESULTS LIST NAVIGATION ---
    // ============================================================

    const REDLIST_KEY = 'coverup_browse_list';

    function isGroupPage() {
        return /torrents\.php/.test(window.location.pathname)
            && /[?&]id=\d+/.test(window.location.search)
            && !window.location.href.includes('action=editgroup');
    }

    function captureResultsList() {
        if (isGroupPage()) return;
        if (!/torrents\.php/.test(window.location.pathname)) return;

        const seen = new Set();
        const groupIds = [];
        document.querySelectorAll('a[href*="torrents.php?id="]').forEach(a => {
            const m = a.href.match(/torrents\.php\?id=(\d+)/);
            if (!m) return;
            const id = m[1];
            if (seen.has(id)) return;
            seen.add(id);
            groupIds.push(id);
        });

        if (groupIds.length > 1) {
            sessionStorage.setItem(REDLIST_KEY, JSON.stringify({
                ids: groupIds,
                listUrl: window.location.href
            }));
        }
    }

    function setupGroupNavButtons() {
        if (!isGroupPage()) return;
        const stored = sessionStorage.getItem(REDLIST_KEY);
        if (!stored) return;

        let data;
        try { data = JSON.parse(stored); } catch(e) { return; }
        const ids = data.ids || [];
        const currentMatch = window.location.href.match(/[?&]id=(\d+)/);
        const currentId = currentMatch ? currentMatch[1] : null;
        const idx = ids.indexOf(currentId);
        if (idx === -1) return;

        const prevId = idx > 0 ? ids[idx - 1] : null;
        const nextId = idx < ids.length - 1 ? ids[idx + 1] : null;
        if (!prevId && !nextId) return;

        const bar = document.createElement('div');
        bar.style.cssText = 'position:fixed;bottom:18px;right:18px;z-index:99998;display:flex;gap:8px;background:#1a1a1a;border:1px solid #444;border-radius:8px;padding:8px;box-shadow:0 4px 16px rgba(0,0,0,0.5);font-family:sans-serif;align-items:center;';

        const counter = document.createElement('span');
        counter.style.cssText = 'color:#888;font-size:12px;padding:0 6px;white-space:nowrap;';
        counter.textContent = `${idx + 1} of ${ids.length}`;
        bar.appendChild(counter);

        if (prevId) {
            const prevBtn = document.createElement('a');
            prevBtn.href = `torrents.php?id=${prevId}`;
            prevBtn.textContent = '← Prev';
            prevBtn.style.cssText = 'padding:7px 14px;background:#333;color:#fff;border-radius:5px;text-decoration:none;font-size:13px;font-weight:bold;white-space:nowrap;';
            bar.appendChild(prevBtn);
        }
        if (nextId) {
            const nextBtn = document.createElement('a');
            nextBtn.href = `torrents.php?id=${nextId}`;
            nextBtn.textContent = 'Next →';
            nextBtn.style.cssText = 'padding:7px 14px;background:#4CAF50;color:#fff;border-radius:5px;text-decoration:none;font-size:13px;font-weight:bold;white-space:nowrap;';
            bar.appendChild(nextBtn);
        }

        const backBtn = document.createElement('a');
        backBtn.href = data.listUrl || '#';
        backBtn.textContent = '☰';
        backBtn.title = 'Back to results list';
        backBtn.style.cssText = 'padding:7px 10px;background:#333;color:#aaa;border-radius:5px;text-decoration:none;font-size:13px;white-space:nowrap;';
        bar.appendChild(backBtn);

        document.body.appendChild(bar);
    }

    captureResultsList();
    setupGroupNavButtons();

    // ============================================================
    // --- COVERUP HIDE/SHOW TOGGLE ---
    // ============================================================
    (function setupCoverUpToggle() {
        if (!isGroupPage() && !document.querySelector('.box_image_albumart')) return;

        const HIDDEN_KEY = 'coverup_labels_hidden';
        const isHidden = GM_getValue(HIDDEN_KEY, false);

        const toggle = document.createElement('div');
        toggle.id = 'coverup-toggle';
        toggle.title = 'CoverUp — click to ' + (isHidden ? 'show' : 'hide') + ' labels';
        toggle.style.cssText = 'position:fixed;bottom:18px;left:18px;z-index:99996;width:14px;height:14px;background:#4CAF50;border-radius:50%;cursor:pointer;box-shadow:0 2px 6px rgba(0,0,0,0.5);opacity:0.8;transition:opacity 0.2s;';
        toggle.onmouseenter = () => { toggle.style.opacity = '1'; };
        toggle.onmouseleave = () => { toggle.style.opacity = '0.8'; };
        document.body.appendChild(toggle);

        function applyVisibility(hidden) {
            document.querySelectorAll('.rehost-link-wrapper').forEach(el => {
                el.style.display = hidden ? 'none' : '';
            });
            toggle.style.background = hidden ? '#ff4444' : '#4CAF50';
            toggle.title = 'CoverUp — click to ' + (hidden ? 'show' : 'hide') + ' labels';
        }

        applyVisibility(isHidden);

        // Re-apply after rescans add new wrappers
        const _origAttach = attachRehostLink;

        toggle.onclick = () => {
            const nowHidden = !GM_getValue(HIDDEN_KEY, false);
            GM_setValue(HIDDEN_KEY, nowHidden);
            applyVisibility(nowHidden);
        };

        // Observe DOM for new wrappers added after lazy-load rescans
        new MutationObserver(() => {
            if (GM_getValue(HIDDEN_KEY, false)) {
                document.querySelectorAll('.rehost-link-wrapper').forEach(el => {
                    el.style.display = 'none';
                });
            }
        }).observe(document.body, { childList: true, subtree: true });
    })();

    // ============================================================
    // --- PARSE ALBUM INFO FROM PAGE ---
    // ============================================================

    function parseAlbumInfo() {
        const info = { artist: '', album: '', year: '' };

        // Read artist and album from structured DOM elements — immune to other
        // userscripts injecting text into the h2's textContent.
        const artistLink = document.querySelector('.header h2 a[href*="artist.php"]');
        if (artistLink) info.artist = artistLink.textContent.trim();

        // Gazelle wraps the album title in <span dir="ltr">
        const albumSpan = document.querySelector('.header h2 span[dir="ltr"]');
        if (albumSpan) {
            info.album = albumSpan.textContent.trim();
        } else {
            // Fallback: strip artist prefix from raw h2 text
            const header = document.querySelector('.header h2');
            if (header) {
                const text  = header.textContent.trim();
                const match = text.match(/^(.+?)\s*[-–—]\s*(.+?)$/);
                if (match) {
                    if (!info.artist) info.artist = match[1].trim();
                    info.album = match[2].trim();
                } else { info.album = text; }
            }
        }

        // Year from the edition/group info block
        if (!info.year) {
            const groupInfo = document.querySelector('.group_info');
            if (groupInfo) {
                const yearMatch = groupInfo.textContent.match(/\b(19|20)\d{2}\b/);
                if (yearMatch) info.year = yearMatch[0];
            }
        }

        // Strip metadata tags like [2001], [Anthology], [Deluxe Edition] from album title
        info.album = info.album
            .replace(/\s*\[[^\]]*\]\s*/g, ' ')
            .replace(/\s{2,}/g, ' ')
            .trim();

        return info;
    }

    // ============================================================
    // --- MULTI-SOURCE IMAGE EXTRACTION ---
    // ============================================================

    function getPageSourceLinks() {
        const links = [];
        const seen  = new Set();
        document.querySelectorAll('a[href]').forEach(a => {
            const href = a.href;
            if (!href || seen.has(href)) return;
            seen.add(href);
            const label = a.textContent.trim() || new URL(href).hostname;

            if      (/discogs\.com\/(?:[^/]+\/)*(?:release|master)\/\d+/i.test(href))
                links.push({ href, source: 'Discogs Direct', label });
            else if (/musicbrainz\.org\/release\/[a-f0-9-]{36}/i.test(href))
                links.push({ href, source: 'MusicBrainz', label });
            else if (/(?:open\.)?qobuz\.com\/(?:[a-z]{2}-[a-z]{2}\/)?album\//i.test(href))
                links.push({ href, source: 'Qobuz', label });
            else if (/music\.apple\.com.*\/album/i.test(href) || /itunes\.apple\.com.*\/album/i.test(href))
                links.push({ href, source: 'Apple Music', label });
            else if (/bandcamp\.com\/(album|music)/i.test(href) || /\.bandcamp\.com/i.test(href))
                links.push({ href, source: 'Bandcamp', label });
            else if (/deezer\.com\/(?:\w+\/)?album\/\d+/i.test(href))
                links.push({ href, source: 'Deezer', label });
            else if (/tidal\.com\/(album|browse\/album)/i.test(href))
                links.push({ href, source: 'Tidal', label });
            else if (/open\.spotify\.com\/album/i.test(href))
                links.push({ href, source: 'Spotify', label });
            else if (/amazon\.(com|co\.uk|de|fr).*\/(dp|gp\/product)/i.test(href))
                links.push({ href, source: 'Amazon', label });
            else if (/beatport\.com\/(release|track)\//i.test(href))
                links.push({ href, source: 'Beatport', label });
        });
        return links;
    }

    function resolveSourceImage(linkObj, callback) {
        const { href, source } = linkObj;
        if      (source === 'Discogs Direct') resolveDiscogsRelease(href, callback);
        else if (source === 'MusicBrainz')    resolveMusicBrainz(href, callback);
        else if (source === 'Apple Music')    resolveAppleMusic(href, callback);
        else if (source === 'Qobuz')          resolveQobuz(href, callback);
        else if (source === 'Deezer')         resolveDeezer(href, callback);
        else if (source === 'Bandcamp')       resolveBandcamp(href, callback);
        else if (source === 'Tidal')          resolveViaOgImage(href, source, callback);
        else if (source === 'Spotify')        resolveSpotify(href, callback);
        else if (source === 'Amazon')         resolveViaOgImage(href, source, callback);
        else if (source === 'Beatport')       resolveBeatport(href, callback);
        else callback(null);
    }

    // --- Discogs: resolve release or master via API, return all images ---
    function resolveDiscogsRelease(href, callback) {
        const token        = getDiscogsToken();
        const releaseMatch = href.match(/discogs\.com\/(?:[^/]+\/)*release\/(\d+)/i);
        const masterMatch  = href.match(/discogs\.com\/(?:[^/]+\/)*master\/(\d+)/i);

        let resourceUrl = null;
        let isMaster    = false;
        let masterId    = null;

        if (releaseMatch)     { resourceUrl = `https://api.discogs.com/releases/${releaseMatch[1]}`; }
        else if (masterMatch) { masterId = masterMatch[1]; resourceUrl = `https://api.discogs.com/masters/${masterId}`; isMaster = true; }
        else { callback(null); return; }

        const headers = { 'User-Agent': 'CoverUp/6.47' };
        if (token) headers['Authorization'] = `Discogs token=${token}`;

        function releaseSummary(rel) {
            const parts = [];
            if (rel.year || rel.released) parts.push(rel.year || rel.released);
            if (rel.country) parts.push(rel.country);
            const fmt = Array.isArray(rel.format) ? rel.format : [];
            if (fmt.length) parts.push(fmt.join(', '));
            const lbl = Array.isArray(rel.label) ? rel.label : [];
            if (lbl.length) parts.push(lbl.slice(0, 2).join(', '));
            return parts.join(' \u2022 ') || 'Discogs release';
        }

        function emitImages(data, pageHref, prefix) {
            const images = data.images || [];
            if (images.length === 0) {
                if (data.thumb) callback({ imageUrl: data.thumb, displayUrl: pageHref, source: 'Discogs Direct', label: prefix ? `${prefix} \u2014 Thumb` : 'Thumb' });
                return;
            }
            const sorted = [...images.filter(i => i.type === 'primary'), ...images.filter(i => i.type !== 'primary')];
            sorted.forEach((img, idx) => callback({
                imageUrl:   img.uri,
                displayUrl: pageHref,
                source:     'Discogs Direct',
                label:      prefix ? `${prefix} \u2014 ${idx === 0 ? 'Primary' : 'Image ' + (idx + 1)}` : (idx === 0 ? 'Primary' : 'Image ' + (idx + 1))
            }));
        }

        GM_xmlhttpRequest({
            method: 'GET', url: resourceUrl, headers, timeout: 10000,
            onload: function(r) {
                try {
                    const data = JSON.parse(r.responseText);
                    emitImages(data, href, isMaster ? 'Master' : 'Release');
                    if (!isMaster) {
                        callback({
                            source: 'Discogs Releases', type: 'release_list', displayUrl: href,
                            releases: [{
                                id:         data.id,
                                title:      data.title || 'Release',
                                year:       data.year || '',
                                country:    data.country || '',
                                format:     data.formats ? data.formats.map(f => f.name) : [],
                                label:      data.labels  ? data.labels.map(l => l.name)  : [],
                                thumb:      data.thumb || '',
                                coverImage: (data.images || []).find(i => i.type === 'primary')?.uri || data.thumb || '',
                                webUrl:     data.uri || `https://www.discogs.com/release/${data.id}`,
                                summary:    releaseSummary({ year: data.year, country: data.country,
                                    format: data.formats ? data.formats.map(f => f.name) : [],
                                    label:  data.labels  ? data.labels.map(l => l.name)  : [] })
                            }]
                        });
                    }
                } catch(e) { console.warn('[CoverUp] Discogs resolve error:', e); callback(null); }
            },
            onerror: function() { callback(null); },
            ontimeout: function() { callback(null); }
        });

        if (isMaster && masterId) {
            const allVersions = [];
            function emitAllVersions() {
                if (!allVersions.length) return;
                callback({
                    source: 'Discogs Releases', type: 'release_list', displayUrl: href,
                    releases: allVersions.map(rel => ({
                        id:         rel.id,
                        title:      rel.title || 'Release',
                        year:       rel.released || rel.year || '',
                        country:    rel.country || '',
                        format:     Array.isArray(rel.format) ? rel.format : [],
                        label:      Array.isArray(rel.label)  ? rel.label  : [],
                        thumb:      rel.thumb || '',
                        coverImage: rel.thumb || '',
                        webUrl:     `https://www.discogs.com/release/${rel.id}`,
                        summary:    releaseSummary(rel)
                    }))
                });
            }
            function fetchVersionsPage(page) {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url: `https://api.discogs.com/masters/${masterId}/versions?per_page=100&page=${page}&sort=released&sort_order=asc`,
                    headers, timeout: 15000,
                    onload: function(r) {
                        try {
                            const data     = JSON.parse(r.responseText);
                            const versions = Array.isArray(data.versions) ? data.versions : [];
                            versions.forEach(v => allVersions.push(v));
                            const pagination  = data.pagination  || {};
                            const totalPages  = pagination.pages || 1;
                            const currentPage = pagination.page  || page;
                            if (currentPage < totalPages) {
                                setTimeout(() => fetchVersionsPage(currentPage + 1), 250);
                            } else {
                                emitAllVersions();
                            }
                        } catch(e) { console.warn('[CoverUp] Discogs versions page error:', e); }
                    },
                    onerror:   function() { console.warn('[CoverUp] Discogs versions fetch failed page ' + page); },
                    ontimeout: function() { console.warn('[CoverUp] Discogs versions timeout page ' + page); }
                });
            }
            fetchVersionsPage(1);
        }
    }

    // --- MusicBrainz: Cover Art Archive API — all images for a release ---
    function resolveMusicBrainz(href, callback) {
        const mbidMatch = href.match(/musicbrainz\.org\/release\/([a-f0-9-]{36})/i);
        if (!mbidMatch) { callback(null); return; }

        GM_xmlhttpRequest({
            method: 'GET',
            url: `https://coverartarchive.org/release/${mbidMatch[1]}`,
            headers: { 'User-Agent': 'RehostREDCovers/6.17 ( https://greasyfork.org/users/1568924 )' },
            timeout: 10000,
            onload: function(r) {
                try {
                    const data   = JSON.parse(r.responseText);
                    const images = data.images || [];
                    if (images.length === 0) { callback(null); return; }
                    const sorted = [
                        ...images.filter(img => img.front),
                        ...images.filter(img => !img.front)
                    ];
                    sorted.forEach((img, i) => {
                        const imageUrl = (img.thumbnails && img.thumbnails['1200'])
                            ? img.thumbnails['1200']
                            : (img.thumbnails && img.thumbnails.large)
                            ? img.thumbnails.large
                            : img.image;
                        const types = img.types && img.types.length
                            ? img.types.join(', ')
                            : (img.front ? 'Front' : 'Image');
                        callback({
                            imageUrl,
                            displayUrl: href,
                            source: 'MusicBrainz',
                            label:  i === 0 ? types : `${types} ${i + 1}`
                        });
                    });
                } catch(e) { console.warn('MusicBrainz CAA error:', e); callback(null); }
            },
            onerror:   function() { callback(null); },
            ontimeout: function() { callback(null); }
        });
    }

    // --- Apple Music: iTunes lookup API at max resolution ---
    function resolveAppleMusic(href, callback) {
        const idMatch = href.match(/\/album\/(?:[^/]+\/)?(\d+)/);
        if (!idMatch) { callback(null); return; }
        GM_xmlhttpRequest({
            method: 'GET',
            url: `https://itunes.apple.com/lookup?id=${idMatch[1]}&entity=album`,
            onload: function(r) {
                try {
                    const data   = JSON.parse(r.responseText);
                    const result = data.results && data.results[0];
                    if (result && result.artworkUrl100) {
                        const imageUrl = result.artworkUrl100
                            .replace(/\d+x\d+bb\.jpg$/, '10000x10000bb.jpg')
                            .replace(/\d+x\d+\.jpg$/,   '10000x10000.jpg');
                        callback({ imageUrl, displayUrl: href, source: 'Apple Music' });
                    } else callback(null);
                } catch(e) { console.warn('Apple Music lookup error:', e); callback(null); }
            },
            onerror: function() { callback(null); }
        });
    }

    // --- Qobuz: all regional variants and open.qobuz.com ---
    // Patterns: qobuz.com/gb-en/album/title/ID  |  open.qobuz.com/album/ID
    function resolveQobuz(href, callback) {
        const idMatch = href.match(/\/album\/(?:[^/]+\/)?([0-9a-zA-Z]+)\/?(?:[?#].*)?$/);
        if (!idMatch) { resolveViaOgImage(href, 'Qobuz', callback); return; }

        const albumId = idMatch[1];
        const level1  = albumId.slice(-2)   || '00';  // last 2 chars
        const level2  = albumId.slice(-4,-2) || '00'; // chars before that
        const cdnUrl  = `https://static.qobuz.com/images/covers/${level1}/${level2}/${albumId}_org.jpg`;
        const cdnUrl600 = `https://static.qobuz.com/images/covers/${level1}/${level2}/${albumId}_600.jpg`;

        // Extract search query from URL slug — more reliable than album ID search
        // e.g. /album/animal-style-wynona-bleach/g47k7vpgx1mgp -> "animal style wynona bleach"
        const slugMatch = href.match(/\/album\/([^/]+)\/[^/]+$/);
        const slugQuery = slugMatch ? slugMatch[1].replace(/-/g, ' ') : '';
        const searchQuery = slugQuery || albumId;

        function trySlugSearch() {
            GM_xmlhttpRequest({
                method: 'GET',
                url: `https://www.qobuz.com/api.json/0.2/album/search?query=${encodeURIComponent(searchQuery)}&limit=5`,
                headers: { 'X-App-Id': '285473059', 'User-Agent': 'Mozilla/5.0' },
                timeout: 8000,
                onload: function(r) {
                    try {
                        const data  = JSON.parse(r.responseText);
                        const items = (data.albums && data.albums.items) || [];
                        const match = items.find(it => String(it.id) === albumId) || items[0];
                        const img   = match && match.image && (match.image.mega || match.image.large);
                        if (img) callback({ imageUrl: img, displayUrl: href, source: 'Qobuz' });
                        else callback(null);
                    } catch(e) { callback(null); }
                },
                onerror: function() { callback(null); }
            });
        }

        // Try CDN URL via Image probe first (fast path for older/established releases)
        // Fall back to slug search if CDN 404s or errors
        const probe = new Image();
        let settled = false;
        const timer = setTimeout(() => {
            if (!settled) { settled = true; trySlugSearch(); }
        }, 4000);
        probe.onload = () => {
            if (settled) return; settled = true; clearTimeout(timer);
            callback({ imageUrl: cdnUrl, displayUrl: href, source: 'Qobuz' });
        };
        probe.onerror = () => {
            if (settled) return; settled = true; clearTimeout(timer);
            trySlugSearch();
        };
        probe.src = cdnUrl;
        // If _org 404s, also try _600
        probe.onerror = () => {
            const probe2 = new Image();
            probe2.onload = () => {
                if (settled) return; settled = true; clearTimeout(timer);
                callback({ imageUrl: cdnUrl600, displayUrl: href, source: 'Qobuz' });
            };
            probe2.onerror = () => {
                if (settled) return; settled = true; clearTimeout(timer);
        trySlugSearch();
            };
            probe2.src = cdnUrl600;
        };
    }

    // --- Deezer: public API returns cover_xl ---
    function resolveDeezer(href, callback) {
        const idMatch = href.match(/\/album\/(\d+)/);
        if (!idMatch) { callback(null); return; }
        GM_xmlhttpRequest({
            method: 'GET',
            url: `https://api.deezer.com/album/${idMatch[1]}`,
            onload: function(r) {
                try {
                    const data = JSON.parse(r.responseText);
                    // Standard cover fields (may be empty for some regions)
                    let imageUrl = data.cover_xl || data.cover_big || data.cover_medium || data.cover;
                    // Fallback: construct URL from md5_image which is always present
                    if (!imageUrl && data.md5_image) {
                        imageUrl = `https://cdn-images.dzcdn.net/images/cover/${data.md5_image}/1000x1000-000000-80-0-0.jpg`;
                    }
                    if (imageUrl) callback({ imageUrl, displayUrl: href, source: 'Deezer' });
                    else callback(null);
                } catch(e) { console.warn('Deezer API error:', e); callback(null); }
            },
            onerror: function() { callback(null); }
        });
    }

    // --- Generic: fetch page HTML and extract og:image / twitter:image ---
    // --- Bandcamp: extract art_id from embedded JSON for true original resolution ---
    function resolveBandcamp(href, callback) {
        GM_xmlhttpRequest({
            method: 'GET', url: href, timeout: 10000,
            onload: function(r) {
                try {
                    const parser = new DOMParser();
                    const doc    = parser.parseFromString(r.responseText, 'text/html');

                    // Bandcamp embeds release data in a <script data-tralbum> JSON blob
                    // which contains art_id — use that to construct the full-res URL
                    const tralbum = doc.querySelector('script[data-tralbum]');
                    if (tralbum) {
                        const data   = JSON.parse(tralbum.dataset.tralbum);
                        const artId  = data.art_id || (data.current && data.current.art_id);
                        if (artId) {
                            // _0 suffix = original resolution on Bandcamp's CDN
                            const imageUrl = `https://f4.bcbits.com/img/a${artId}_0.jpg`;
                            callback({ imageUrl, displayUrl: href, source: 'Bandcamp' });
                            return;
                        }
                    }

                    // Fallback: og:image with _7 → _0 bump
                    const og = doc.querySelector('meta[property="og:image"]') ||
                               doc.querySelector('meta[name="twitter:image"]') ||
                               doc.querySelector('meta[property="og:image:secure_url"]');
                    if (og && og.content) {
                        const imageUrl = og.content.replace(/_7\.(jpg|jpeg|png)/i, '_0.$1');
                        callback({ imageUrl, displayUrl: href, source: 'Bandcamp' });
                    } else callback(null);
                } catch(e) { console.warn('Bandcamp parse error:', e); callback(null); }
            },
            onerror:   function() { callback(null); },
            ontimeout: function() { callback(null); }
        });
    }

    // --- Beatport: validate actual CDN <img> matches over blindly trusting og:image ---
    const BEATPORT_CDN_IMG_RE = /geo-media\.beatport\.com\/image_size\/\d+x\d+\/[a-f0-9-]+\.(jpg|jpeg|png)/i;
    function resolveBeatport(href, callback) {
        GM_xmlhttpRequest({
            method: 'GET', url: href, timeout: 10000,
            onload: function(r) {
                try {
                    const parser = new DOMParser();
                    const doc    = parser.parseFromString(r.responseText, 'text/html');
                    let imageUrl = null;
                    const cdnImg = Array.from(doc.querySelectorAll('img')).find(img => {
                        const src = img.getAttribute('src') || '';
                        return BEATPORT_CDN_IMG_RE.test(src);
                    });
                    if (cdnImg) {
                        imageUrl = cdnImg.getAttribute('src');
                    } else {
                        const og = doc.querySelector('meta[property="og:image"]') ||
                                   doc.querySelector('meta[name="twitter:image"]');
                        if (og && og.content && BEATPORT_CDN_IMG_RE.test(og.content)) {
                            imageUrl = og.content;
                        }
                    }
                    if (imageUrl) {
                        // Beatport CDN: geo-media.beatport.com/image_size/250x250/{id}.jpg
                        // Bump to 1400x1400 (largest commonly available) for original quality
                        imageUrl = imageUrl.replace(/\/image_size\/\d+x\d+\//, '/image_size/1400x1400/');
                        callback({ imageUrl, displayUrl: href, source: 'Beatport' });
                    } else {
                        console.warn('[CoverUp] Beatport: no valid cover art found on page (possibly a blocked/interstitial response) —', href);
                        callback(null);
                    }
                } catch(e) { console.warn('Beatport parse error:', e); callback(null); }
            },
            onerror:   function() { callback(null); },
            ontimeout: function() { callback(null); }
        });
    }

    // --- Generic: fetch page HTML and extract og:image / twitter:image ---
    function resolveSpotify(href, callback) {
        // Use Spotify oEmbed API — works cross-origin, returns thumbnail_url
        const oembed = `https://open.spotify.com/oembed?url=${encodeURIComponent(href)}`;
        GM_xmlhttpRequest({
            method: 'GET', url: oembed, timeout: 10000,
            onload: function(r) {
                try {
                    const data = JSON.parse(r.responseText);
                    if (data.thumbnail_url) {
                        // thumbnail_url is typically 300px — bump to larger size
                        const large = data.thumbnail_url.replace('/300/', '/640/').replace('\?width=300', '?width=640');
                        callback({ imageUrl: large, displayUrl: href, source: 'Spotify' });
                    } else {
                        callback(null);
                    }
                } catch(e) { callback(null); }
            },
            onerror:   () => callback(null),
            ontimeout: () => callback(null),
        });
    }

    function resolveViaOgImage(href, source, callback) {
        GM_xmlhttpRequest({
            method: 'GET', url: href, timeout: 10000,
            onload: function(r) {
                try {
                    const parser = new DOMParser();
                    const doc    = parser.parseFromString(r.responseText, 'text/html');
                    const og     = doc.querySelector('meta[property="og:image"]') ||
                                   doc.querySelector('meta[name="twitter:image"]') ||
                                   doc.querySelector('meta[property="og:image:secure_url"]');
                    if (og && og.content) callback({ imageUrl: og.content, displayUrl: href, source });
                    else callback(null);
                } catch(e) { console.warn(`og:image parse error for ${source}:`, e); callback(null); }
            },
            onerror:   function() { callback(null); },
            ontimeout: function() { callback(null); }
        });
    }

    // ============================================================
    // --- DISCOGS KEYWORD SEARCH ---
    // ============================================================

    // Search Discogs using multiple query strategies, then fetch full release
    // images for any result that has an empty cover_image in the search index.
    function searchDiscogs(query, callback, albumInfo) {
        const token = getDiscogsToken();
        if (!token) { callback([]); return; }

        function stripPunct(s) {
            return (s || '').replace(/[?!&–—]/g, ' ').replace(/\s{2,}/g, ' ').trim();
        }

        function buildStrategies(rawQuery, info) {
            const cleaned = stripPunct(rawQuery);
            const artist = stripPunct(info && info.artist ? info.artist : '');
            const album  = stripPunct(info && info.album ? info.album : '');
            // Structured field queries first (most precise), then freetext fallback
            const C = (artist && album)
                ? 'artist=' + encodeURIComponent(artist) + '&release_title=' + encodeURIComponent(album) + '&type=release&per_page=10'
                : null;
            const D = album
                ? 'release_title=' + encodeURIComponent(album) + '&type=release&per_page=10'
                : null;
            // Freetext fallback — catches cases where field search returns nothing
            const E = (artist && album)
                ? 'q=' + encodeURIComponent(artist + ' ' + album) + '&type=release&per_page=10'
                : null;
            const seen = new Set();
            return [C, D, E].filter(s => s && !seen.has(s) && seen.add(s));
        }

        function fetchReleaseImages(releaseId, cb) {
            GM_xmlhttpRequest({
                method:  'GET',
                url:     'https://api.discogs.com/releases/' + releaseId + '?token=' + token,
                headers: { 'User-Agent': 'REDCoverRehost/6.21' },
                timeout: 15000,
                onload: function(r) {
                    try {
                        const data   = JSON.parse(r.responseText);
                        const images = (data.images || []).filter(function(img) { return img.uri && img.uri.startsWith('http'); });
                        cb(images);
                    } catch(e) { cb([]); }
                },
                onerror: function() { cb([]); },
                ontimeout: function() { cb([]); }
            });
        }

        const strategies = buildStrategies(query, albumInfo || {});
        let strategyIndex = 0;

        function tryNextStrategy() {
            if (strategyIndex >= strategies.length) {
                console.warn('[Rehost] All Discogs strategies exhausted — no results found.');
                callback([]); return;
            }
            const params = strategies[strategyIndex++];
            const fullUrl = 'https://api.discogs.com/database/search?' + params + '&token=' + token;
            console.log('[Rehost] Discogs strategy', strategyIndex, ':', fullUrl.replace(token, 'TOKEN'));
            GM_xmlhttpRequest({
                method: 'GET',
                url: fullUrl,
                headers: { 'User-Agent': 'REDCoverRehost/6.21' },
                timeout: 15000,
                onload: function(r) {
                    console.log('[Rehost] Discogs response status:', r.status, '— body length:', r.responseText.length);
                    try {
                        const parsed = JSON.parse(r.responseText);
                        const results = parsed.results || [];
                        console.log('[Rehost] Discogs results count:', results.length,
                            results.map(function(x){ return x.id + ':' + (x.cover_image ? 'has_cover' : 'no_cover'); }));
                        // Filter results for relevance before accepting
                        const artistLow = (albumInfo && albumInfo.artist || '').toLowerCase();
                        const albumLow  = (albumInfo && albumInfo.album  || '').toLowerCase();
                        const relevant  = results.filter(r => {
                            const t = (r.title || '').toLowerCase();
                            // Discogs title format is "Artist - Album"
                            // Check artist words first (most discriminating)
                            const artistWords = artistLow.split(/\s+/).filter(w => w.length > 2);
                            if (artistWords.length && !artistWords.some(w => t.includes(w))) return false;
                            // If no artist words matched nothing or artist is short/common,
                            // also check album words
                            const albumWords = albumLow.split(/\s+/).filter(w => w.length > 3);
                            if (!artistWords.length && albumWords.length && !albumWords.some(w => t.includes(w))) return false;
                            return true;
                        });
                        console.log('[Rehost] Discogs relevant after filter:', relevant.length, 
                            'from', results.length, 'artistLow:', artistLow, 
                            'titles:', results.slice(0,3).map(r => r.title));
                        if (relevant.length === 0) { tryNextStrategy(); return; }
                        const results_filtered = relevant;
                        // Re-assign for downstream use
                        results.length = 0; results_filtered.forEach(r => results.push(r));
                        if (results.length === 0) { tryNextStrategy(); return; }
                        const withoutCover = results.filter(function(rel) {
                            return !rel.cover_image || rel.cover_image.includes('spacer.gif');
                        });
                        console.log('[Rehost] Results needing release fetch:', withoutCover.length);
                        if (withoutCover.length === 0) { callback(results); return; }
                        const toFetch = withoutCover.slice(0, 5);
                        let fetched = 0;
                        toFetch.forEach(function(rel) {
                            fetchReleaseImages(rel.id, function(images) {
                                console.log('[Rehost] Release', rel.id, 'fetch returned', images.length, 'images');
                                if (images.length > 0) {
                                    const primary = images.find(function(i) { return i.type === 'primary'; }) || images[0];
                                    rel.cover_image = primary.uri;
                                    rel._allImages = images;
                                }
                                fetched++;
                                if (fetched === toFetch.length) {
                                    console.log('[Rehost] All release fetches done — calling back with', results.length, 'results');
                                    callback(results);
                                }
                            });
                        });
                    } catch(e) { console.error('[Rehost] Discogs parse error:', e); tryNextStrategy(); }
                },
                onerror: function(e) { console.error('[Rehost] Discogs XHR error:', e); tryNextStrategy(); },
                ontimeout: function() { console.warn('[Rehost] Discogs XHR timeout'); tryNextStrategy(); }
            });
        }

        tryNextStrategy();
    }

    // ============================================================
    // --- ARTIST IMAGE SEARCH (Discogs / Deezer, by artist name) ---
    // ============================================================
    // Everything above searches by ARTIST+ALBUM to find a release cover. Artist photos
    // (the header image on artist.php, distinct from any release's cover art) need a
    // different kind of search — by artist name alone, against each service's artist
    // endpoint rather than its album/release endpoint.

    // Discogs artist search results never include an image directly (confirmed live:
    // "thumb"/"cover_image" come back empty for type=artist), so a candidate has to be
    // resolved with a second call to /artists/{id}, which does return an "images" array.
    // Discogs disambiguates same-named artists with a trailing " (2)", "(3)", etc. —
    // strip that before comparing so "Boards of Canada (2)" still counts as an exact
    // match for "Boards of Canada". Otherwise this is a strict, case-insensitive,
    // whitespace-normalised equality check — no substring/fuzzy matching allowed, so
    // e.g. "Warp Brain Records" never passes as a match for "Warp Records".
    function normalizeArtistNameForMatch(s) {
        return (s || '').toLowerCase().replace(/\s*\(\d+\)\s*$/, '').replace(/\s+/g, ' ').trim();
    }
    function isExactArtistNameMatch(candidateName, targetName) {
        return normalizeArtistNameForMatch(candidateName) === normalizeArtistNameForMatch(targetName);
    }

    function searchDiscogsArtistImages(name, callback) {
        const token = getDiscogsToken();
        if (!token) { callback([]); return; }
        const cleaned = (name || '').trim();
        if (!cleaned) { callback([]); return; }

        GM_xmlhttpRequest({
            method: 'GET',
            url: 'https://api.discogs.com/database/search?q=' + encodeURIComponent(cleaned) + '&type=artist&per_page=5&token=' + token,
            headers: { 'User-Agent': 'REDCoverRehost/6.21' },
            timeout: 15000,
            onload: function(r) {
                try {
                    const parsed = JSON.parse(r.responseText);
                    // Require an exact name match — anything else is treated as unfound
                    // rather than offered up as a loose guess.
                    const results = (parsed.results || []).filter(res => isExactArtistNameMatch(res.title, cleaned)).slice(0, 3);
                    if (results.length === 0) { callback([]); return; }
                    const out = [];
                    let pending = results.length;
                    results.forEach(res => {
                        GM_xmlhttpRequest({
                            method: 'GET',
                            url: 'https://api.discogs.com/artists/' + res.id + '?token=' + token,
                            headers: { 'User-Agent': 'REDCoverRehost/6.21' },
                            timeout: 15000,
                            onload: function(r2) {
                                try {
                                    const detail = JSON.parse(r2.responseText);
                                    const images = (detail.images || []).filter(i => i.uri);
                                    if (images.length > 0) {
                                        const primary = images.find(i => i.type === 'primary') || images[0];
                                        const pageUrl = res.uri ? 'https://www.discogs.com' + res.uri : ('https://www.discogs.com/artist/' + res.id);
                                        out.push({ imageUrl: primary.uri, label: res.title || '', searchSource: 'Discogs (artist)', pageUrl });
                                    }
                                } catch(e) {}
                                if (--pending === 0) callback(out);
                            },
                            onerror: function() { if (--pending === 0) callback(out); },
                            ontimeout: function() { if (--pending === 0) callback(out); },
                        });
                    });
                } catch(e) { callback([]); }
            },
            onerror: function() { callback([]); },
            ontimeout: function() { callback([]); },
        });
    }

    // When an artist has no real photo on Deezer, it serves a generic default-avatar
    // silhouette instead of omitting the field — confirmed pattern: the image path has
    // an empty artist-id segment ("/artist//..."), unlike a real photo's "/artist/<id>/...".
    // Those need to be filtered out, or every "candidate" would just be the same blank icon.
    function isDeezerDefaultAvatar(url) {
        return /\/artist\/\/\d+x\d+/.test(url || '');
    }

    // Deezer's artist search returns picture URLs directly — no token, no second call.
    function searchDeezerArtistImages(name, callback) {
        const cleaned = (name || '').trim();
        if (!cleaned) { callback([]); return; }
        GM_xmlhttpRequest({
            method: 'GET',
            url: `https://api.deezer.com/search/artist?q=${encodeURIComponent(cleaned)}&limit=3`,
            timeout: 10000,
            onload: function(r) {
                try {
                    const data = JSON.parse(r.responseText);
                    // Same exact-match requirement as Discogs — a near-miss name is
                    // treated as no result, not a loose candidate to approve.
                    const items = (data.data || []).filter(i => isExactArtistNameMatch(i.name, cleaned)).slice(0, 3);
                    const out = items.map(i => {
                        const url = i.picture_xl || i.picture_big || i.picture_medium || i.picture;
                        if (!url || isDeezerDefaultAvatar(url)) return null;
                        const pageUrl = i.link || (i.id ? 'https://www.deezer.com/artist/' + i.id : null);
                        return { imageUrl: url, label: i.name || '', searchSource: 'Deezer (artist)', pageUrl };
                    }).filter(Boolean);
                    callback(out);
                } catch(e) { callback([]); }
            },
            onerror: function() { callback([]); },
            ontimeout: function() { callback([]); },
        });
    }

    // Fans both artist-image sources out and aggregates into the same
    // { imageUrl, label, searchSource } shape the approval-thumbnail UI already expects.
    // Discogs candidates are listed first — since they've proven more reliable in
    // practice than Deezer's artist search — regardless of which search finishes first.
    function searchArtistImageCandidates(name, callback) {
        let deezerResults = [];
        let discogsResults = [];
        const hasDiscogsToken = !!getDiscogsToken();
        const SOURCES = hasDiscogsToken ? 2 : 1;
        let done = 0;
        function finish() { if (++done === SOURCES) callback([...discogsResults, ...deezerResults]); }

        searchDeezerArtistImages(name, items => { deezerResults = items; finish(); });
        if (hasDiscogsToken) {
            searchDiscogsArtistImages(name, items => { discogsResults = items; finish(); });
        }
    }

    // ============================================================
    // --- ARTIST IMAGE SUBMIT (cookie-authenticated form POST) ---
    // ============================================================
    // Not part of RED's documented ajax.php API (same undocumented-but-observed pattern as
    // the alt-cover add/remove flow above): artist.php?action=edit is a plain HTML form,
    // cookie-authenticated with a page-scraped "auth" CSRF token. The live edit page is
    // fetched first so the existing bio/notes/vanity-house values can be resubmitted
    // unchanged — omitting them would blank out the artist's existing wiki content.
    function fetchArtistEditFormData(artistId, cb) {
        GM_xmlhttpRequest({
            method: 'GET',
            url: 'artist.php?action=edit&artistid=' + artistId,
            timeout: 15000,
            onload: function(r) {
                try {
                    const doc = new DOMParser().parseFromString(r.responseText, 'text/html');
                    const form = [...doc.querySelectorAll('form')].find(f => {
                        const actionInput = f.querySelector('input[name="action"]');
                        return actionInput && actionInput.value === 'edit' && f.querySelector('input[name="artistid"]');
                    });
                    if (!form) { cb(null); return; }
                    const authInput  = form.querySelector('input[name="auth"]');
                    const bodyEl     = form.querySelector('textarea[name="body"]');
                    const notesEl    = form.querySelector('textarea[name="artisteditnotes"]');
                    const vanityEl   = form.querySelector('input[name="vanity_house"]');
                    cb({
                        auth: authInput ? authInput.value : null,
                        body: bodyEl ? bodyEl.value : '',
                        notes: notesEl ? notesEl.value : '',
                        vanityChecked: vanityEl ? vanityEl.checked : false,
                    });
                } catch(e) { cb(null); }
            },
            onerror: function() { cb(null); },
            ontimeout: function() { cb(null); },
        });
    }

    function submitArtistImage(artistId, imageUrl, cb) {
        fetchArtistEditFormData(artistId, function(formData) {
            if (!formData || !formData.auth) { cb(false, 'could not find edit form / auth token'); return; }
            const fd = new FormData();
            fd.append('action', 'edit');
            fd.append('auth', formData.auth);
            fd.append('artistid', artistId);
            fd.append('image', imageUrl);
            fd.append('body', formData.body || '');
            fd.append('artisteditnotes', formData.notes || '');
            if (formData.vanityChecked) fd.append('vanity_house', '1');
            fd.append('summary', 'Added missing artist image via CoverUp');
            GM_xmlhttpRequest({
                method: 'POST',
                url: 'artist.php',
                data: fd,
                timeout: 20000,
                onload: function(resp) {
                    if (resp.status >= 200 && resp.status < 400) cb(true);
                    else cb(false, 'HTTP ' + resp.status);
                },
                onerror: function() { cb(false, 'network error'); },
                ontimeout: function() { cb(false, 'timed out'); },
            });
        });
    }

    // ============================================================
    // --- UNIFIED MULTI-SOURCE IMAGE PICKER OVERLAY ---
    // ============================================================

    const SOURCE_BADGE_COLORS = {
        'Discogs Direct': '#333',
        'MusicBrainz':    '#ba478f',
        'Apple Music':    '#fc3c44',
        'Qobuz':          '#0070c9',
        'Deezer':         '#a238ff',
        'Bandcamp':       '#1da0c3',
        'Tidal':          '#222',
        'Spotify':        '#1DB954',
        'Amazon':         '#ff9900',
        'Beatport':       '#94d500',
    };


    // ============================================================
    // --- DEEZER SEARCH ---
    // ============================================================

    function searchDeezer(albumInfo, callback) {
        const artist = (albumInfo.artist || '').trim();
        const album  = (albumInfo.album  || '').trim();
        if (!artist && !album) { callback([]); return; }

        const q = [artist, album].filter(Boolean).join(' ');
        GM_xmlhttpRequest({
            method: 'GET',
            url: `https://api.deezer.com/search/album?q=${encodeURIComponent(q)}&limit=10`,
            timeout: 10000,
            onload: function(r) {
                try {
                    const data = JSON.parse(r.responseText);
                    const items = data.data || [];
                    callback(items);
                } catch(e) { callback([]); }
            },
            onerror:   function() { callback([]); },
            ontimeout: function() { callback([]); }
        });
    }

    // ============================================================
    // --- MUSICBRAINZ SEARCH ---
    // ============================================================

    function searchMusicBrainz(albumInfo, callback) {
        const artist = (albumInfo.artist || '').trim();
        const album  = (albumInfo.album  || '').trim();
        if (!artist && !album) { callback([]); return; }

        // MusicBrainz Lucene query: artist + release fields
        let luceneQuery;
        if (artist && album) {
            luceneQuery = `artist:"${artist}" AND release:"${album}"`;
        } else if (album) {
            luceneQuery = `release:"${album}"`;
        } else {
            luceneQuery = `artist:"${artist}"`;
        }

        GM_xmlhttpRequest({
            method: 'GET',
            url: `https://musicbrainz.org/ws/2/release/?query=${encodeURIComponent(luceneQuery)}&fmt=json&limit=8`,
            headers: { 'User-Agent': 'CoverUp/6.37 ( https://greasyfork.org/users/1568924 )' },
            timeout: 12000,
            onload: function(r) {
                try {
                    const data     = JSON.parse(r.responseText);
                    const releases = (data.releases || []).filter(rel => rel.id);
                    if (releases.length === 0) { callback([]); return; }

                    const results = [];
                    let pending   = releases.length;

                    releases.forEach(rel => {
                        GM_xmlhttpRequest({
                            method: 'GET',
                            url: `https://coverartarchive.org/release/${rel.id}`,
                            headers: { 'User-Agent': 'CoverUp/6.37 ( https://greasyfork.org/users/1568924 )' },
                            timeout: 8000,
                            onload: function(r2) {
                                try {
                                    const caa = JSON.parse(r2.responseText);
                                    if (caa.images && caa.images.length > 0) {
                                        const sorted = [
                                            ...caa.images.filter(i => i.front),
                                            ...caa.images.filter(i => !i.front)
                                        ];
                                        sorted.forEach(img => {
                                            const imageUrl = (img.thumbnails && img.thumbnails['1200'])
                                                || (img.thumbnails && img.thumbnails.large)
                                                || img.image;
                                            results.push({
                                                imageUrl,
                                                title:    rel.title,
                                                artist:   rel['artist-credit'] && rel['artist-credit'][0]
                                                            ? rel['artist-credit'][0].name : '',
                                                date:     rel.date || rel['release-group'] && rel['release-group']['first-release-date'] || '',
                                                label:    img.front ? 'Front' : (img.types && img.types[0] || 'Image'),
                                                mbid:     rel.id
                                            });
                                        });
                                    }
                                } catch(e) {}
                                if (--pending === 0) callback(results);
                            },
                            onerror:   function() { if (--pending === 0) callback(results); },
                            ontimeout: function() { if (--pending === 0) callback(results); }
                        });
                    });
                } catch(e) { callback([]); }
            },
            onerror:   function() { callback([]); },
            ontimeout: function() { callback([]); }
        });
    }

    // ============================================================
    // --- QOBUZ SEARCH ---
    // ============================================================

    function searchQobuz(albumInfo, callback) {
        const artist = (albumInfo.artist || '').trim();
        const album  = (albumInfo.album  || '').trim();
        if (!artist && !album) { callback([]); return; }

        // Qobuz public search — artist+album gives much better results than freetext
        const q = [artist, album].filter(Boolean).join(' ');

        GM_xmlhttpRequest({
            method: 'GET',
            url: `https://www.qobuz.com/api.json/0.2/album/search?query=${encodeURIComponent(q)}&limit=10`,
            headers: {
                'X-App-Id': '285473059',
                'User-Agent': 'Mozilla/5.0'
            },
            timeout: 12000,
            onload: function(r) {
                try {
                    const data  = JSON.parse(r.responseText);
                    const items = (data.albums && data.albums.items) || [];
                    // Boost exact-match items to the top
                    const albumLower  = album.toLowerCase();
                    const artistLower = artist.toLowerCase();
                    items.sort((a, b) => {
                        const aMatch = (a.title || '').toLowerCase().includes(albumLower) &&
                                       (a.artist && a.artist.name || '').toLowerCase().includes(artistLower);
                        const bMatch = (b.title || '').toLowerCase().includes(albumLower) &&
                                       (b.artist && b.artist.name || '').toLowerCase().includes(artistLower);
                        return (bMatch ? 1 : 0) - (aMatch ? 1 : 0);
                    });
                    callback(items);
                } catch(e) { callback([]); }
            },
            onerror:   function() { callback([]); },
            ontimeout: function() { callback([]); }
        });
    }


    // ============================================================
    // --- BANDCAMP SEARCH ---
    // ============================================================

    function searchBandcamp(albumInfo, callback) {
        const artist = (albumInfo.artist || '').trim();
        const album  = (albumInfo.album  || '').trim();
        if (!album) { callback([]); return; }

        // Skip artist for VA/unknown releases — "Unknown Artist(s)" / "Various Artists"
        // are RED-specific labels that won't match anything on Bandcamp
        const VA_PATTERNS = /^(unknown artist|various artists?|va|various|multiple artists?)$/i;
        const useArtist = artist && !VA_PATTERNS.test(artist);

        // Also try a shorter query using only the part before a colon in the album title
        // e.g. "The Weevil Series: Pupa" → try "The Weevil Series Pupa" and "Pupa"
        const albumShort = album.replace(/\s*:.*$/, '').trim();

        const q = [useArtist ? artist : '', album].filter(Boolean).join(' ').trim()
               || album;

        function parseResults(html) {
            const parser = new DOMParser();
            const doc    = parser.parseFromString(html, 'text/html');
            const results = [];
            doc.querySelectorAll('.result-items li').forEach(el => {
                // Accept album-type items (filter by itemtype div or class)
                const itemType = el.querySelector('.itemtype');
                const typeText = itemType ? itemType.textContent.trim().toUpperCase() : '';
                if (typeText && typeText !== 'ALBUM') return;

                const thumb     = el.querySelector('img');
                const headingEl = el.querySelector('.heading a');
                const subheadEl = el.querySelector('.subhead');
                if (!thumb || !headingEl) return;

                // Must use getAttribute('src') not .src — DOMParser doesn't
                // load resources so .src returns a wrong origin-prefixed URL
                const src = thumb.getAttribute('data-src') || thumb.getAttribute('src') || '';
                if (!src || !src.includes('bcbits.com')) return; // skip if no valid CDN URL
                const imageUrl = src.replace(/_\d+\.(jpg|jpeg|png)/i, '_0.$1');
                const href   = headingEl.href;
                const title  = headingEl.textContent.trim();
                const artist = (subheadEl ? subheadEl.textContent : '').replace(/^by\s*/i, '').trim();
                if (imageUrl && href) results.push({ imageUrl, href, title, artist });
            });
            return results;
        }

        function doSearch(query, fallbackQuery) {
            GM_xmlhttpRequest({
                method: 'GET',
                url: `https://bandcamp.com/search?q=${encodeURIComponent(query)}&item_type=a`,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                },
                timeout: 12000,
                onload: function(r) {
                    try {
                        const results = parseResults(r.responseText);
                        if (results.length === 0 && fallbackQuery && fallbackQuery !== query) {
                            // Retry with shorter/simpler query
                            doSearch(fallbackQuery, null);
                        } else {
                            callback(results);
                        }
                    } catch(e) { console.warn('Bandcamp search error:', e); callback([]); }
                },
                onerror:   function() { callback([]); },
                ontimeout: function() { callback([]); }
            });
        }

        // Try full query first; fall back to album title only (short form before colon)
        const fallback = albumShort !== album ? albumShort : (useArtist ? album : null);
        doSearch(q, fallback);
    }

    // ============================================================
    // --- ITUNES SEARCH ---
    // ============================================================

    function searchItunes(albumInfo, callback) {
        const artist = (albumInfo.artist || '').trim();
        const album  = (albumInfo.album  || '').trim();
        if (!artist && !album) { callback([]); return; }

        // iTunes Search API: term = "Artist Album", entity=album, media=music
        const term = [artist, album].filter(Boolean).join(' ');
        GM_xmlhttpRequest({
            method: 'GET',
            url: `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=album&media=music&limit=12`,
            timeout: 10000,
            onload: function(r) {
                try {
                    const data = JSON.parse(r.responseText);
                    const items = (data.results || []).filter(a => a.artworkUrl100);
                    // Boost exact artist+album matches to top
                    const aLow = artist.toLowerCase();
                    const bLow = album.toLowerCase();
                    items.sort((x, y) => {
                        const xMatch = (x.collectionName || '').toLowerCase().includes(bLow) &&
                                       (x.artistName     || '').toLowerCase().includes(aLow);
                        const yMatch = (y.collectionName || '').toLowerCase().includes(bLow) &&
                                       (y.artistName     || '').toLowerCase().includes(aLow);
                        return (yMatch ? 1 : 0) - (xMatch ? 1 : 0);
                    });
                    callback(items);
                } catch(e) { callback([]); }
            },
            onerror:   function() { callback([]); },
            ontimeout: function() { callback([]); }
        });
    }

    // ============================================================
    // --- AMAZON SEARCH ---
    // ============================================================

    function searchAmazon(albumInfo, callback) {
        const artist = (albumInfo.artist || '').trim();
        const album  = (albumInfo.album  || '').trim();
        if (!artist && !album) { callback([]); return; }

        // Amazon Music search via their open search endpoint
        // Returns product pages — we extract the ASIN and build the image URL directly
        const query = [artist, album].filter(Boolean).join(' ');
        GM_xmlhttpRequest({
            method: 'GET',
            url: `https://www.amazon.com/s?k=${encodeURIComponent(query)}&i=popular&search-type=ss`,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept-Language': 'en-US,en;q=0.9'
            },
            timeout: 12000,
            onload: function(r) {
                try {
                    const parser = new DOMParser();
                    const doc    = parser.parseFromString(r.responseText, 'text/html');
                    const results = [];
                    const seen    = new Set();

                    // Extract ASINs from search results
                    doc.querySelectorAll('[data-asin]').forEach(el => {
                        const asin = el.getAttribute('data-asin');
                        if (!asin || asin.length < 10 || seen.has(asin)) return;
                        seen.add(asin);

                        // Try to get the image from the result card
                        const img = el.querySelector('img.s-image');
                        let imageUrl = img && img.getAttribute('src');
                        // Upgrade to high-res: replace the size suffix
                        if (imageUrl) {
                            imageUrl = imageUrl.replace(/\._[A-Z0-9_,]+_\./, '.');
                        }

                        const titleEl = el.querySelector('h2 span, .a-text-normal');
                        const title   = titleEl ? titleEl.textContent.trim() : asin;

                        if (imageUrl && imageUrl.startsWith('https://')) {
                            results.push({ asin, imageUrl, title });
                        }
                    });

                    callback(results.slice(0, 10));
                } catch(e) { callback([]); }
            },
            onerror:   function() { callback([]); },
            ontimeout: function() { callback([]); }
        });
    }

    function createImagePickerOverlay(albumInfo, callback) {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.92);z-index:100000;display:flex;align-items:center;justify-content:center;overflow:auto;';

        const container = document.createElement('div');
        container.style.cssText = 'background:#1a1a1a;padding:30px;border-radius:12px;border:2px solid #444;max-width:960px;width:92%;color:#fff;font-family:sans-serif;max-height:92vh;overflow-y:auto;';

        container.innerHTML = `
            <h2 style="margin-top:0;color:#4CAF50;">🎵 Select Artwork</h2>
            <p style="color:#ccc;margin-bottom:16px;">
                <strong>${albumInfo.artist}${albumInfo.album ? ' – ' + albumInfo.album : ''}${albumInfo.year ? ' (' + albumInfo.year + ')' : ''}</strong>
            </p>
            <div id="picker-tabs" style="display:flex;gap:6px;margin-bottom:20px;flex-wrap:wrap;">
                <button class="picker-tab active" data-tab="sources"
                    style="padding:7px 16px;border-radius:6px;border:none;cursor:pointer;font-size:13px;font-weight:bold;background:#4CAF50;color:#fff;">
                    📄 Page Sources <span id="sources-count" style="opacity:0.7;">(scanning…)</span>
                </button>
                <button class="picker-tab" data-tab="discogs"
                    style="padding:7px 16px;border-radius:6px;border:none;cursor:pointer;font-size:13px;font-weight:bold;background:#333;color:#aaa;">
                    🔍 Discogs Search <span id="discogs-count" style="opacity:0.7;">(loading…)</span>
                </button>
                <button class="picker-tab" data-tab="streaming"
                    style="padding:7px 16px;border-radius:6px;border:none;cursor:pointer;font-size:13px;font-weight:bold;background:#333;color:#aaa;">
                    🎵 Deezer / Qobuz / MB / BC <span id="streaming-count" style="opacity:0.7;">(loading…)</span>
                </button>
                <button class="picker-tab" data-tab="retail"
                    style="padding:7px 16px;border-radius:6px;border:none;cursor:pointer;font-size:13px;font-weight:bold;background:#333;color:#aaa;">
                    🛒 iTunes / Amazon <span id="retail-count" style="opacity:0.7;">(loading…)</span>
                </button>
            </div>
            <div id="panel-sources">
                <div id="sources-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:16px;">
                    <div style="grid-column:1/-1;text-align:center;padding:30px;color:#888;">Scanning page for source links…</div>
                </div>
            </div>
            <div id="panel-discogs" style="display:none;">
                <div id="discogs-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:16px;">
                    <div style="grid-column:1/-1;text-align:center;padding:30px;color:#888;">
                        <div style="font-size:32px;margin-bottom:8px;">🔍</div>Searching Discogs…
                    </div>
                </div>
            </div>
            <div id="panel-streaming" style="display:none;">
                <div id="streaming-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:16px;">
                    <div style="grid-column:1/-1;text-align:center;padding:30px;color:#888;">
                        <div style="font-size:32px;margin-bottom:8px;">🎵</div>Searching Deezer, Qobuz & MusicBrainz…
                    </div>
                </div>
            </div>
            <div id="panel-retail" style="display:none;">
                <div id="retail-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:16px;">
                    <div style="grid-column:1/-1;text-align:center;padding:30px;color:#888;">
                        <div style="font-size:32px;margin-bottom:8px;">🛒</div>Searching iTunes & Amazon…
                    </div>
                </div>
            </div>
            <div style="margin-top:22px;border-top:1px solid #444;padding-top:18px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
                <div style="width:100%;font-size:11px;color:#888;margin-bottom:2px;">
                    Paste any direct image URL — or a Spotify track, album, or playlist URL and the artwork will be resolved automatically.
                </div>
                <input type="text" id="custom-url-input" placeholder="Or paste any image URL…"
                    style="flex:1;min-width:200px;padding:9px 12px;background:#222;border:1px solid #555;color:#fff;border-radius:4px;font-size:13px;">
                <button id="use-custom-url" style="padding:9px 18px;background:#2196F3;color:#fff;border:none;border-radius:4px;cursor:pointer;white-space:nowrap;">Use URL</button>
                <button id="upload-from-disk" style="padding:9px 18px;background:#7c3aed;color:#fff;border:none;border-radius:4px;cursor:pointer;white-space:nowrap;">📁 Upload from computer</button>
                <input type="file" id="disk-file-input" accept="image/*" style="display:none;">
                <button id="skip-picker"    style="padding:9px 18px;background:#ff9800;color:#fff;border:none;border-radius:4px;cursor:pointer;white-space:nowrap;">Use Original</button>
                <button id="cancel-picker"  style="padding:9px 18px;background:#555;color:#fff;border:none;border-radius:4px;cursor:pointer;">Cancel</button>
            </div>


            <div id="url-preview" style="display:none;margin-top:12px;padding:12px;background:#1a1a1a;border:1px solid #444;border-radius:6px;align-items:center;gap:14px;">
                <img id="url-preview-img" src="" alt="preview" style="width:80px;height:80px;object-fit:contain;border-radius:4px;background:#111;">
                <div id="url-preview-info" style="font-size:12px;color:#aaa;line-height:1.6;"></div>
            </div>
        `;

        overlay.appendChild(container);
        document.body.appendChild(overlay);

        // --- Tab switching ---
        container.querySelectorAll('.picker-tab').forEach(btn => {
            btn.addEventListener('click', () => {
                container.querySelectorAll('.picker-tab').forEach(b => { b.style.background = '#333'; b.style.color = '#aaa'; });
                btn.style.background = '#4CAF50'; btn.style.color = '#fff';
                container.querySelector('#panel-sources').style.display   = btn.dataset.tab === 'sources'   ? '' : 'none';
                container.querySelector('#panel-discogs').style.display   = btn.dataset.tab === 'discogs'   ? '' : 'none';
                container.querySelector('#panel-streaming').style.display = btn.dataset.tab === 'streaming' ? '' : 'none';
                container.querySelector('#panel-retail').style.display    = btn.dataset.tab === 'retail'    ? '' : 'none';
            });
        });

        // --- Footer actions ---
        container.querySelector('#use-custom-url').onclick = () => {
            const url = container.querySelector('#custom-url-input').value.trim();
            if (url) { document.body.removeChild(overlay); callback('__customurl__:' + url); }
            else alert('Please enter a URL');
        };
        container.querySelector('#skip-picker').onclick   = () => { document.body.removeChild(overlay); callback('SKIP'); };
        container.querySelector('#cancel-picker').onclick = () => { document.body.removeChild(overlay); callback(''); };

        container.querySelector('#upload-from-disk').onclick = () => {
            container.querySelector('#disk-file-input').click();
        };
        container.querySelector('#disk-file-input').onchange = function() {
            const file = this.files && this.files[0];
            if (!file) return;
            document.body.removeChild(overlay);
            callback('__localfile__:' + URL.createObjectURL(file));
        };
        container.querySelector('#custom-url-input').addEventListener('keypress', e => {
            if (e.key === 'Enter') container.querySelector('#use-custom-url').click();
        });

        // Live URL preview — debounced, shows thumbnail + dimensions on paste/type
        let urlPreviewTimer = null;
        const urlPreviewDiv  = container.querySelector('#url-preview');
        const urlPreviewImg  = container.querySelector('#url-preview-img');
        const urlPreviewInfo = container.querySelector('#url-preview-info');

        function showUrlPreview(url) {
            if (!url) { urlPreviewDiv.style.display = 'none'; return; }
            urlPreviewInfo.textContent = 'Loading…';
            urlPreviewDiv.style.display = 'flex';
            urlPreviewImg.src = '';

            // For Spotify track/album/playlist URLs, resolve via oEmbed first
            // to get a real i.scdn.co image URL — then preview that
            if (/open\.spotify\.com\/(track|album|playlist)\//i.test(url)) {
                urlPreviewInfo.textContent = 'Resolving Spotify artwork…';
                GM_xmlhttpRequest({
                    method: 'GET',
                    url: `https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`,
                    headers: { 'Accept': 'application/json' },
                    timeout: 8000,
                    onload: function(r) {
                        try {
                            const data = JSON.parse(r.responseText);
                            const imageUrl = data.thumbnail_url;
                            if (imageUrl) {
                                // Update the input field to the resolved image URL
                                // so "Use URL" submits the actual image, not the Spotify page URL
                                container.querySelector('#custom-url-input').value = imageUrl;
                                showUrlPreview(imageUrl);
                            } else {
                                showPreviewError(url, 'Spotify oEmbed returned no image');
                            }
                        } catch(e) { showPreviewError(url, 'Could not resolve Spotify URL'); }
                    },
                    onerror:   function() { showPreviewError(url, 'Could not reach Spotify'); },
                    ontimeout: function() { showPreviewError(url, 'Spotify request timed out'); }
                });
                return;
            }

            function showPreviewError(u, msg) {
                urlPreviewImg.src = '';
                urlPreviewInfo.innerHTML =
                    `<span style="color:#ccc;word-break:break-all;">${u.length > 80 ? u.slice(0,77)+'…' : u}</span><br>` +
                    `<span style="color:#f44;">${msg}</span>`;
            }

            const probe = new Image();
            probe.onload = () => {
                urlPreviewImg.src = url;
                const w = probe.naturalWidth, h = probe.naturalHeight;
                const sizeOk = w >= 500 && h >= 500;
                urlPreviewInfo.innerHTML =
                    `<span style="color:#ccc;word-break:break-all;">${url.length > 80 ? url.slice(0,77)+'…' : url}</span><br>` +
                    `<span style="color:${sizeOk ? '#4CAF50' : '#ff9800'};">${w} × ${h}px</span>` +
                    (sizeOk ? '' : ' <span style="color:#ff9800;">— may be too small</span>');
            };
            probe.onerror = () => showPreviewError(url, 'Could not load image — URL may not be a direct image link');
            probe.src = url;
        }

        container.querySelector('#custom-url-input').addEventListener('input', e => {
            clearTimeout(urlPreviewTimer);
            const val = e.target.value.trim();
            if (!val) { urlPreviewDiv.style.display = 'none'; return; }
            urlPreviewTimer = setTimeout(() => showUrlPreview(val), 600);
        });

        // Also trigger immediately on paste
        container.querySelector('#custom-url-input').addEventListener('paste', e => {
            clearTimeout(urlPreviewTimer);
            // Use setTimeout to let paste complete before reading value
            urlPreviewTimer = setTimeout(() => {
                const val = e.target.value.trim();
                if (val) showUrlPreview(val);
            }, 100);
        });


        // --- Card factory ---
        function makeCard(imageUrl, title, subtitle, badgeText, badgeColor, onClickUrl, detailLines) {
            const card = document.createElement('div');
            card.style.cssText = 'background:#222;border-radius:8px;padding:8px;cursor:pointer;transition:all 0.15s;border:2px solid transparent;position:relative;';
            card.innerHTML = `
                <img src="${imageUrl}" loading="lazy"
                    style="width:100%;height:160px;object-fit:contain;border-radius:5px;display:block;background:#1a1a1a;">
                <div style="margin-top:8px;font-size:11px;">
                    <div style="font-weight:bold;color:#4CAF50;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${title}">${title}</div>
                    ${subtitle ? `<div style="color:#888;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${subtitle}">${subtitle}</div>` : ''}
                    ${detailLines && detailLines.length ? detailLines.map(l => `<div style="color:#aaa;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:10px;" title="${l}">${l}</div>`).join('') : ''}
                </div>
                <div style="position:absolute;top:12px;left:12px;background:${badgeColor};color:#fff;padding:2px 7px;border-radius:3px;font-size:10px;font-weight:bold;border:1px solid rgba(255,255,255,0.15);">${badgeText}</div>
                <div class="res-badge" style="position:absolute;top:12px;right:12px;background:rgba(0,0,0,0.75);color:#fff;padding:2px 7px;border-radius:3px;font-size:10px;font-weight:bold;">…</div>
            `;
            card.onmouseenter = () => { card.style.borderColor = '#4CAF50'; card.style.transform = 'scale(1.03)'; };
            card.onmouseleave = () => { card.style.borderColor = 'transparent'; card.style.transform = 'scale(1)'; };
            card.onclick = () => { document.body.removeChild(overlay); callback(onClickUrl); };
            const probe   = new Image();
            probe.onload  = () => {
                const badge = card.querySelector('.res-badge');
                badge.textContent = `${probe.width}×${probe.height}`;
                badge.style.background = (probe.width < MIN_RESOLUTION || probe.height < MIN_RESOLUTION)
                    ? 'rgba(244,67,54,0.85)' : 'rgba(76,175,80,0.85)';
            };
            probe.onerror = () => { card.querySelector('.res-badge').textContent = '?'; };
            probe.src = imageUrl;
            return card;
        }

        // --- Page Sources ---
        const sourcesGrid    = container.querySelector('#sources-grid');
        const sourcesCountEl = container.querySelector('#sources-count');
        const sourceLinks    = getPageSourceLinks();

        if (sourceLinks.length === 0) {
            sourcesGrid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:30px;color:#888;">No recognised source links found on this page.<br><small style="opacity:0.6;">Try the Discogs Search tab or paste a URL below.</small></div>';
            sourcesCountEl.textContent = '(0)';
        } else {
            sourcesGrid.innerHTML = '';
            sourcesCountEl.textContent = `(0/${sourceLinks.length})`;
            let resolved = 0, found = 0;

            const seenReleaseLists = new Set();

            sourceLinks.forEach(linkObj => {
                let firstCall = true;
                resolveSourceImage(linkObj, result => {
                    if (firstCall) { resolved++; firstCall = false; }

                    if (result && result.imageUrl) {
                        found++;
                        sourcesCountEl.textContent = `(${found})`;
                        const color = SOURCE_BADGE_COLORS[result.source] || '#555';
                        sourcesGrid.appendChild(makeCard(
                            result.imageUrl,
                            result.source,
                            result.label || linkObj.label,
                            result.label || result.source,
                            color,
                            result.imageUrl
                        ));
                    } else if (result && result.type === 'release_list' && Array.isArray(result.releases) && result.releases.length) {
                        // Render each release version directly as a card in the grid
                        result.releases.forEach(rel => {
                            const thumb = rel.coverImage || rel.thumb;
                            if (!thumb) return;
                            found++;
                            sourcesCountEl.textContent = `(${found})`;
                            const card = makeCard(
                                thumb,
                                rel.title || 'Release',
                                [rel.country, rel.year].filter(Boolean).join(' · '),
                                'Discogs',
                                SOURCE_BADGE_COLORS['Discogs Direct'] || '#e74c3c',
                                thumb,
                                [[rel.format && rel.format.join(', '), rel.label && rel.label.slice(0,2).join(', ')].filter(Boolean).join(' · ')]
                            );
                            // On click, fetch full-res image first
                            card.onclick = null;
                            card.addEventListener('click', () => {
                                const token = getDiscogsToken();
                                const headers = { 'User-Agent': 'CoverUp/7.0' };
                                if (token) headers['Authorization'] = `Discogs token=${token}`;
                                if (rel.country && rel.year && img) img.dataset.coverupSummary = [rel.country, rel.year].filter(Boolean).join(', ');
                                GM_xmlhttpRequest({
                                    method: 'GET',
                                    url: `https://api.discogs.com/releases/${rel.id}`,
                                    headers, timeout: 10000,
                                    onload: function(r) {
                                        try {
                                            const data = JSON.parse(r.responseText);
                                            const primary = (data.images || []).find(i => i.type === 'primary') || data.images && data.images[0];
                                            const srcUrl = (primary && primary.uri) || thumb;
                                            document.body.removeChild(overlay);
                                            callback(srcUrl);
                                        } catch(e) { document.body.removeChild(overlay); callback(thumb); }
                                    },
                                    onerror: function() { document.body.removeChild(overlay); callback(thumb); }
                                });
                            });
                            sourcesGrid.appendChild(card);
                        });
                    }

                    if (resolved === sourceLinks.length && found === 0) {
                        sourcesGrid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:30px;color:#888;">Source links found but no artwork could be extracted.<br><small style="opacity:0.6;">Try the Discogs Search tab or paste a URL below.</small></div>';
                        sourcesCountEl.textContent = '(0)';
                    }
                });
            });
        }

        // --- Discogs keyword search ---
        // Helpers to format Discogs release details matching the Discogs UI layout
        function buildDiscogsSubtitle(rel) {
            const parts = [];
            if (rel.format && rel.format.length) parts.push(rel.format.join(', '));
            return parts.join(' · ') || '';
        }
        function buildDiscogsDetailLines(rel) {
            const lines = [];
            // Label – Catalog Number
            const labels  = (rel.label  || []).slice(0, 2).join(', ');
            const catnos  = (rel.catno  || '').trim();
            if (labels || catnos) lines.push([labels, catnos].filter(Boolean).join(' – '));
            // Country  Year
            const country = rel.country || '';
            const year    = rel.year    || '';
            if (country || year) lines.push([country, year].filter(Boolean).join('  ·  '));
            return lines;
        }

        const discogsGrid    = container.querySelector('#discogs-grid');
        const discogsCountEl = container.querySelector('#discogs-count');

        if (!getDiscogsToken()) {
            discogsGrid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:30px;color:#888;">No Discogs token set.<br><small>Click "⚙ Set Discogs Token" below to enable.</small></div>';
            discogsCountEl.textContent = '(no token)';
        } else {
            const searchQuery = `${albumInfo.artist} ${albumInfo.album} ${albumInfo.year}`.trim();
            console.log('[Rehost] albumInfo:', JSON.stringify(albumInfo));
            console.log('[Rehost] searchQuery:', searchQuery);
            searchDiscogs(searchQuery, function(results) {
                discogsGrid.innerHTML = '';
                const filtered = results.filter(r => (r.cover_image && !r.cover_image.includes('spacer.gif')) || (r._allImages && r._allImages.length > 0));
                discogsCountEl.textContent = `(${filtered.length})`;
                if (filtered.length === 0) {
                    discogsGrid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:30px;color:#888;"><div style="font-size:32px;margin-bottom:8px;">❌</div>No Discogs results found.</div>';
                    return;
                }
                filtered.forEach(release => {
                    if (release._allImages && release._allImages.length > 1) {
                        release._allImages.forEach(function(img, idx) {
                            const typeLabel = img.type === 'primary' ? 'Primary' : ('Image ' + (idx + 1));
                            discogsGrid.appendChild(makeCard(
                                img.uri,
                                release.title + ' — ' + typeLabel,
                                buildDiscogsSubtitle(release),
                                'Discogs',
                                SOURCE_BADGE_COLORS['Discogs Direct'] || '#e74c3c',
                                img.uri,
                                buildDiscogsDetailLines(release)
                            ));
                        });
                        return;
                    }
                    discogsGrid.appendChild(makeCard(
                        release.cover_image,
                        release.title,
                        buildDiscogsSubtitle(release),
                        'Discogs',
                        '#e74c3c',
                        release.cover_image,
                        buildDiscogsDetailLines(release)
                    ));
                });
            }, albumInfo);
        }

        // --- Deezer / Qobuz / MusicBrainz search ---
        const streamingGrid    = container.querySelector('#streaming-grid');
        const streamingCountEl = container.querySelector('#streaming-count');

        let streamingFound = 0;
        let streamingDone  = 0;
        const STREAMING_SOURCES = 4;
        streamingGrid.innerHTML = '';

        // Relevance filter — artist must match unless VA/unknown
        const VA_PATTERN = /^(unknown artist|various artists?|va|various|multiple artists?)$/i;
        const searchArtist = (albumInfo.artist || '').trim().toLowerCase();
        const searchAlbum  = (albumInfo.album  || '').trim().toLowerCase();
        const isVA = !searchArtist || VA_PATTERN.test(searchArtist);

        function wordsOf(s) {
            return (s || '').toLowerCase().split(/[\s\-&,]+/).filter(w => w.length > 2);
        }
        function anyWordMatches(needle, haystack) {
            const nw = wordsOf(needle);
            if (!nw.length) return true;
            const hw = haystack.toLowerCase();
            return nw.some(w => hw.includes(w));
        }

        function isRelevant(resultTitle, resultArtist) {
            const ra = (resultArtist || '').toLowerCase();
            const rt = (resultTitle  || '').toLowerCase();

            if (!isVA && searchArtist) {
                if (ra) {
                    // Have artist field — it must match
                    if (!anyWordMatches(searchArtist, ra)) return false;
                } else {
                    // No artist field — require album title to match instead
                    if (searchAlbum && !anyWordMatches(searchAlbum, rt)) return false;
                }
            }

            // Album title check — always required when we have an album name
            if (searchAlbum) {
                const albumWords = wordsOf(searchAlbum);
                const distinctiveWords = albumWords.filter(w => w.length > 4);

                if (distinctiveWords.length > 0) {
                    // Album has distinctive long words — require at least one to match
                    if (!distinctiveWords.some(w => rt.includes(w))) return false;
                } else {
                    // Short album title (e.g. "Love", "Help!", "1") — require
                    // the full title to appear as a word boundary match in the result
                    const escaped = searchAlbum.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    const pattern = new RegExp('(?:^|[\\s\\-–—:])' + escaped + '(?:$|[\\s\\-–—:(])', 'i');
                    if (!pattern.test(rt)) return false;
                }
            }

            return true;
        }

        function onStreamingDone() {
            streamingDone++;
            if (streamingFound === 0 && streamingDone === STREAMING_SOURCES) {
                streamingGrid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:30px;color:#888;"><div style="font-size:32px;margin-bottom:8px;">❌</div>No results found on Deezer, Qobuz, MusicBrainz, or Bandcamp.</div>';
                streamingCountEl.textContent = '(0)';
            }
        }

        // Deezer
        searchDeezer(albumInfo, function(items) {
            items.filter(a => isRelevant(a.title, a.artist && a.artist.name)).forEach(a => {
                let imageUrl = a.cover_xl || a.cover_big || a.cover_medium || a.cover;
                if (!imageUrl && a.md5_image) {
                    imageUrl = `https://cdn-images.dzcdn.net/images/cover/${a.md5_image}/1000x1000-000000-80-0-0.jpg`;
                }
                if (!imageUrl) return;
                streamingGrid.appendChild(makeCard(
                    imageUrl,
                    a.title || 'Unknown',
                    a.artist && a.artist.name ? a.artist.name : '',
                    'Deezer',
                    '#a238ff',
                    imageUrl
                ));
                streamingFound++;
                streamingCountEl.textContent = `(${streamingFound})`;
            });
            onStreamingDone();
        });

        // Qobuz
        searchQobuz(albumInfo, function(items) {
                items.filter(a => isRelevant(a.title, (a.artist && (a.artist.name || a.artist)) || '')).forEach(a => {
                // Prefer API image fields; fall back to two-level CDN URL from ID
                const qImg = a.image && (a.image.mega || a.image.large || a.image.small);
                let imageUrl = (qImg && qImg.trim()) || '';
                if (!imageUrl && a.id) {
                    const aid = String(a.id);
                    const l1 = aid.slice(-2);
                    const l2 = aid.slice(-4, -2);
                    imageUrl = `https://static.qobuz.com/images/covers/${l1}/${l2}/${aid}_org.jpg`;
                }
                if (!imageUrl) return;
                streamingGrid.appendChild(makeCard(
                    imageUrl,
                    a.title || 'Unknown',
                    a.artist && a.artist.name ? a.artist.name : '',
                    'Qobuz',
                    '#1e90ff',
                    imageUrl
                ));
                streamingFound++;
                streamingCountEl.textContent = `(${streamingFound})`;
            });
            onStreamingDone();
        });

        // MusicBrainz
        searchMusicBrainz(albumInfo, function(results) {
            results.filter(r => isRelevant(r.title, r.artist)).forEach(r => {
                streamingGrid.appendChild(makeCard(
                    r.imageUrl,
                    r.title || 'Unknown',
                    [r.artist, r.date].filter(Boolean).join(' · '),
                    'MB ' + r.label,
                    '#eb743b',
                    r.imageUrl
                ));
                streamingFound++;
                streamingCountEl.textContent = `(${streamingFound})`;
            });
            onStreamingDone();
        });

        // Bandcamp
        searchBandcamp(albumInfo, function(items) {
            items.filter(a => isRelevant(a.title, a.artist)).forEach(a => {
                streamingGrid.appendChild(makeCard(
                    a.imageUrl,
                    a.title || 'Unknown',
                    a.artist || '',
                    'Bandcamp',
                    '#1da0c3',
                    a.imageUrl
                ));
                streamingFound++;
                streamingCountEl.textContent = `(${streamingFound})`;
            });
            onStreamingDone();
        });


        // --- iTunes / Amazon search ---
        const retailGrid    = container.querySelector('#retail-grid');
        const retailCountEl = container.querySelector('#retail-count');

        let retailFound = 0;
        let retailDone  = 0;
        const RETAIL_SOURCES = 2;
        retailGrid.innerHTML = '';

        function onRetailDone() {
            retailDone++;
            if (retailFound === 0 && retailDone === RETAIL_SOURCES) {
                retailGrid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:30px;color:#888;"><div style="font-size:32px;margin-bottom:8px;">❌</div>No results found on iTunes or Amazon.</div>';
                retailCountEl.textContent = '(0)';
            }
        }

        // iTunes
        searchItunes(albumInfo, function(items) {
            items.filter(a => isRelevant(a.collectionName, a.artistName)).forEach(a => {
                const imageUrl = a.artworkUrl100
                    .replace(/\d+x\d+bb\.jpg$/, '10000x10000bb.jpg')
                    .replace(/\d+x\d+\.jpg$/,   '10000x10000.jpg');
                retailGrid.appendChild(makeCard(
                    imageUrl,
                    a.collectionName || 'Unknown',
                    a.artistName || '',
                    'iTunes',
                    '#fc3c44',
                    imageUrl
                ));
                retailFound++;
                retailCountEl.textContent = `(${retailFound})`;
            });
            onRetailDone();
        });

        // Amazon
        searchAmazon(albumInfo, function(items) {
            items.filter(a => isRelevant(a.title, '')).forEach(a => {
                retailGrid.appendChild(makeCard(
                    a.imageUrl,
                    a.title || 'Unknown',
                    'Amazon',
                    'Amazon',
                    '#ff9900',
                    a.imageUrl
                ));
                retailFound++;
                retailCountEl.textContent = `(${retailFound})`;
            });
            onRetailDone();
        });

    }

    // ============================================================
    // --- COVER QUALITY VALIDATION ---
    // ============================================================

    const coverSelectors = ['.box_image_albumart #covers img', '.artist_profile img'];

    function checkImageQuality(img) {
        return new Promise((resolve) => {
            // Always use the real URL — Gazelle lazy-loads alt covers via data-gazelle-temp-src
            // so img.src may be blank until cover_art.js sets it.
            const actualUrl = getActualImageUrl(img);

            if (!actualUrl || actualUrl.includes('/static/common/noartwork/') || actualUrl.includes('blank.gif')) {
                resolve({ needsRehost: true, resizeOnly: false, reasons: ['No artwork'] });
                return;
            }

            // Check host against bad/trigger domains using the real URL
            let badHost = false;
            try {
                const urlObj = new URL(actualUrl);
                if (REHOST_TRIGGERS.some(h => urlObj.hostname.includes(h))) {
                    badHost = true;
                }
            } catch(e) {}

            function resolveFromDimensions(w, h, broken) {
                if (broken) {
                    resolve({ needsRehost: true, resizeOnly: false, reasons: ['Broken image'], width: 0, height: 0 });
                    return;
                }
                const issues = [];
                if (badHost) issues.push(`Hosted on ${new URL(actualUrl).hostname} — rehost recommended`);
                if (w > 0 && h > 0) {
                    if (w < MIN_RESOLUTION || h < MIN_RESOLUTION)
                        issues.push(`Low resolution (${w}×${h})`);
                    if (w > MAX_DIMENSION || h > MAX_DIMENSION)
                        issues.push(`Too large (${w}×${h})`);
                }
                const isOversized = w > MAX_DIMENSION || h > MAX_DIMENSION;
                const isLowRes    = w < MIN_RESOLUTION || h < MIN_RESOLUTION;
                const resizeOnly  = isOversized && !isLowRes && !badHost;
                resolve({ needsRehost: issues.length > 0, resizeOnly, reasons: issues, width: w, height: h });
            }

            // If the img element has already loaded with real dimensions, use them directly
            if (img.complete && img.naturalWidth > 0) {
                resolveFromDimensions(img.naturalWidth, img.naturalHeight, false);
                return;
            }

            // img.src is blank or not yet loaded — probe the actual URL via a fresh Image
            const probe = new Image();
            const timer = setTimeout(() => {
                probe.onload = probe.onerror = null;
                resolveFromDimensions(0, 0, true); // timeout = treat as broken
            }, 6000);
            probe.onload = () => {
                clearTimeout(timer);
                resolveFromDimensions(probe.naturalWidth, probe.naturalHeight, false);
            };
            probe.onerror = () => {
                clearTimeout(timer);
                resolveFromDimensions(0, 0, true);
            };
            probe.src = actualUrl;
        });
    }

    // ============================================================
    // --- ACTUAL IMAGE URL HELPER ---
    // ============================================================
    // Gazelle lazy-loads covers: the real URL lives in data-gazelle-temp-src
    // before img.src settles. Always prefer that over img.src to avoid
    // rehosting the torrent page URL instead of the actual image.
    function getActualImageUrl(img) {
        const badPrefix = window.location.origin + window.location.pathname + '?';
        const candidates = [
            img.getAttribute('data-gazelle-temp-src'),
            img.getAttribute('data-src'),
            img.currentSrc && !img.currentSrc.startsWith(badPrefix) ? img.currentSrc : null,
            img.src && !img.src.startsWith(badPrefix) ? img.src : null
        ].filter(u => u && u.trim());
        return candidates[0] || img.src || '';
    }

    // ============================================================
    // --- ATTACH REHOST / RESIZE LINKS ---
    // ============================================================

    // ============================================================
    // --- DISCOGS RELEASE PICKER ---
    // ============================================================
    function escHtml(s) {
        return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    }

    function openDiscogsReleasePicker(releases, linkEl, img, callback) {
        const prev = document.getElementById('coverup-discogs-picker');
        if (prev) prev.remove();

        const box = document.createElement('div');
        box.id = 'coverup-discogs-picker';
        Object.assign(box.style, {
            position:  'fixed', top: '60px', right: '20px', zIndex: '99999',
            width:     '420px', maxHeight: '72vh', overflowY: 'auto',
            background: '#1e1e1e', color: '#ddd',
            border: '1px solid #555', borderRadius: '8px',
            padding: '12px 14px', boxShadow: '0 8px 28px rgba(0,0,0,0.55)',
            fontFamily: 'sans-serif', fontSize: '13px'
        });

        const hdr = document.createElement('div');
        hdr.style.cssText = 'font-weight:bold;font-size:14px;margin-bottom:10px;padding-right:50px;';
        hdr.textContent = `Discogs releases (${releases.length})`;
        box.appendChild(hdr);

        const closeBtn = document.createElement('a');
        closeBtn.href = '#';
        closeBtn.textContent = '✕ close';
        closeBtn.style.cssText = 'position:absolute;top:12px;right:12px;color:#999;text-decoration:none;';
        closeBtn.addEventListener('click', e => { e.preventDefault(); box.remove(); });
        box.appendChild(closeBtn);

        releases.forEach(rel => {
            const row = document.createElement('div');
            row.style.cssText = 'display:flex;gap:10px;padding:8px 0;border-top:1px solid #2d2d2d;align-items:flex-start;';

            if (rel.coverImage || rel.thumb) {
                const thumb = document.createElement('img');
                thumb.src = rel.coverImage || rel.thumb;
                thumb.alt = '';
                thumb.style.cssText = 'width:54px;height:54px;object-fit:cover;flex:0 0 54px;background:#333;border-radius:3px;';
                row.appendChild(thumb);
            } else {
                const ph = document.createElement('div');
                ph.style.cssText = 'width:54px;height:54px;flex:0 0 54px;background:#333;border-radius:3px;display:flex;align-items:center;justify-content:center;color:#666;font-size:20px;';
                ph.textContent = '🎵';
                row.appendChild(ph);
            }

            const meta = document.createElement('div');
            meta.style.cssText = 'flex:1 1 auto;min-width:0;';

            meta.innerHTML = `<div style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escHtml(rel.title)}</div>
                <div style="color:#aaa;font-size:0.87em;margin:3px 0 6px;">${escHtml(rel.summary)}</div>`;

            const btnRow = document.createElement('div');
            btnRow.style.cssText = 'display:flex;gap:10px;flex-wrap:wrap;';

            const openLink = document.createElement('a');
            openLink.href = rel.webUrl || '#';
            openLink.target = '_blank';
            openLink.rel = 'noopener noreferrer';
            openLink.textContent = '[open]';
            openLink.style.color = '#7ab8ff';
            btnRow.appendChild(openLink);

            if (rel.coverImage || rel.thumb) {
                const useBtn = document.createElement('a');
                useBtn.href = '#';
                useBtn.textContent = '[use this cover]';
                useBtn.style.color = '#7ddd5c';
                useBtn.addEventListener('click', function(e) {
                    e.preventDefault();
                    box.remove();

                    // Build summary tag from release metadata e.g. "UK, 1970"
                    const relParts = [rel.country, rel.year].filter(Boolean);
                    const relSummary = relParts.join(', ');
                    if (img && relSummary) img.dataset.coverupSummary = relSummary;

                    // Fetch the full release to get the proper full-res image URI
                    // (master version list only has thumbnails)
                    const token = getDiscogsToken();
                    const headers = { 'User-Agent': 'CoverUp/7.0' };
                    if (token) headers['Authorization'] = `Discogs token=${token}`;

                    useBtn.textContent = '[loading…]';
                    GM_xmlhttpRequest({
                        method: 'GET',
                        url: `https://api.discogs.com/releases/${rel.id}`,
                        headers,
                        timeout: 10000,
                        onload: function(r) {
                            try {
                                const data = JSON.parse(r.responseText);
                                const primary = (data.images || []).find(i => i.type === 'primary') || data.images && data.images[0];
                                const srcUrl = (primary && primary.uri) || rel.coverImage || rel.thumb;
                                if (typeof callback === 'function') {
                                    callback(srcUrl);
                                } else if (img) {
                                    handleUploadSuccess(srcUrl, linkEl && linkEl.dataset && linkEl.dataset.rehostOldUrl || srcUrl, linkEl, img);
                                }
                            } catch(e) {
                                // Fallback to thumb if fetch fails
                                const srcUrl = rel.coverImage || rel.thumb;
                                if (typeof callback === 'function') callback(srcUrl);
                                else if (img) handleUploadSuccess(srcUrl, srcUrl, linkEl, img);
                            }
                        },
                        onerror: function() {
                            const srcUrl = rel.coverImage || rel.thumb;
                            if (typeof callback === 'function') callback(srcUrl);
                            else if (img) handleUploadSuccess(srcUrl, srcUrl, linkEl, img);
                        }
                    });
                });
                btnRow.appendChild(useBtn);
            }

            meta.appendChild(btnRow);
            row.appendChild(meta);
            box.appendChild(row);
        });

        document.body.appendChild(box);
    }

    function attachRehostLink(img) {
        const parentP = img.closest('p') || img.parentNode;
        if (!parentP || img.dataset.rehostAttached) return;
        const rawSrc = img.getAttribute('src') || '';
        // For blank.gif, check if there's a stored URL in the edit form
        // If so, show the broken link label now rather than [no artwork]
        if (rawSrc.includes('blank.gif')) {
            // The edit form isn't on the release page — fetch stored image URL via API
            const _gidMatch = window.location.href.match(/[?&]id=(\d+)/);
            const _gid = _gidMatch ? _gidMatch[1] : null;
            if (_gid && getRedApiKey()) {
                redApiThrottle().then(() => GM_xmlhttpRequest({
                    method: 'GET',
                    url: `https://redacted.sh/ajax.php?action=torrentgroup&id=${_gid}`,
                    headers: { 'Authorization': getRedApiKey() },
                    timeout: 8000,
                    onload: function(r) {
                        try {
                            const data = JSON.parse(r.responseText);
                            const storedUrl = data.status === 'success'
                                ? (data.response.group.wikiImage || '').trim() : '';
                            if (!storedUrl) return;
                            const existingWrapper = img.closest('#cover_div_0')?.querySelector('.rehost-link-wrapper');
                            if (existingWrapper) existingWrapper.remove();
                            img.removeAttribute('data-rehost-attached');
                            _attachBlankWithUrl(img, storedUrl);
                        } catch(e) { console.warn('[CoverUp] torrentgroup parse error:', e); }
                    },
                    onerror:   function(e) { console.warn('[CoverUp] torrentgroup onerror:', e); },
                    ontimeout: function()  { console.warn('[CoverUp] torrentgroup timeout'); }
                }));
            }
            // Falls through — shows [no artwork] initially; API call replaces it if URL found
        }

        function _attachBlankWithUrl(img, storedUrl) {
            // Remove any existing rehost labels (e.g. the interim [no artwork] one).
            // The label is inserted BEFORE the cover_div, so we look in the parent.
            const coverDiv = img.closest('[id^="cover_div_"]');
            const searchRoot = coverDiv ? coverDiv.parentNode : (img.closest('#covers') || document);
            searchRoot.querySelectorAll('.rehost-link-wrapper').forEach(el => {
                // Only remove wrappers that are siblings of cover_div_0, not alt covers
                if (!coverDiv || el.nextElementSibling === coverDiv || el.previousElementSibling === coverDiv) {
                    el.remove();
                }
            });
            const ld = document.createElement('div');
            ld.className = 'rehost-link-wrapper';
            ld.style.cssText = 'text-align:center;margin-bottom:5px;';
            const lk = document.createElement('a');
            lk.href = 'javascript:void(0)';
            lk.style.cssText = 'cursor:pointer;font-weight:bold;';
            const isRed  = storedUrl.includes('redacted.sh/i/') || storedUrl.includes('redacted.sh/t/') || storedUrl.includes('images.redacted.sh');
            const isGood = ['imgbb.com','catbox.moe','ra.thesungod.xyz','ibb.co'].some(d => storedUrl.includes(d));
            if (isRed) {
                lk.textContent = "[Image hosted on RED — rehost anyway?]";
                lk.style.color = '#4CAF50';
            } else if (isGood) {
                lk.textContent = `[already on ${friendlyHostName(storedUrl)} — redo?]`;
                lk.style.color = '#4CAF50';
            } else {
                lk.textContent = `[broken ${friendlyHostName(storedUrl)} link — rehost?]`;
                lk.style.color = '#ff4444';
            }
            const us = document.createElement('div');
            us.style.cssText = 'font-size:0.78em;color:#aaa;word-break:break-all;margin-top:2px;user-select:all;';
            us.textContent = storedUrl;
            lk.onclick = (e) => { e.preventDefault(); img.dataset.rehostOldUrl = storedUrl; rehostImage(img, lk); };
            ld.appendChild(lk); ld.appendChild(us);
            // Insert BEFORE the parent p so it appears above the (blank) image area
            const pp = img.closest('p') || img.parentNode;
            pp.parentNode.insertBefore(ld, pp);
            img.dataset.rehostAttached = 'true';
        }
        img.dataset.rehostOldUrl = getActualImageUrl(img);
        // Restore persisted rehosted state across page loads.
        // Use the actual image URL (not img.src which may be blank for lazy-loaded alt covers).
        // Only restore if the stored value points to a different URL (i.e. this was a source
        // that got rehosted elsewhere). Don't restore 'self' entries — those are rehost
        // *destinations* stored to prevent double-uploading, not source tracking.
        const actualUrlForLookup = getActualImageUrl(img);
        const persistedRehost = getRehostedUrl(actualUrlForLookup);
        if (persistedRehost && persistedRehost !== 'self') {
            img.dataset.rehostedUrl = persistedRehost;
        }

        const linkDiv = document.createElement('div');
        linkDiv.className = 'rehost-link-wrapper';
        linkDiv.style.cssText = 'text-align:center;margin-bottom:5px;';

        const link = document.createElement('a');
        link.href = 'javascript:void(0)';
        link.textContent = '[checking...]';
        link.style.cssText = 'cursor:pointer;font-weight:bold;';

        linkDiv.appendChild(link);
        // Insert the rehost link OUTSIDE the cover_div so Gazelle's cover_art.js jQuery
        // delegation never sees the click event — insertBefore puts it just before the cover_div.
        const coverDivAncestor = img.closest('[id^="cover_div_"]');
        if (coverDivAncestor && coverDivAncestor.parentNode) {
            coverDivAncestor.parentNode.insertBefore(linkDiv, coverDivAncestor);
        } else {
            parentP.insertBefore(linkDiv, parentP.firstChild);
        }

        checkImageQuality(img).then(result => {
            const currentUrl = getActualImageUrl(img);
            const isNoArtwork = result.reasons && result.reasons.includes('No artwork');
            if (isNoArtwork) {
                link.textContent = '[no artwork — search for some?]';
                link.style.color = '#aaa';
                link.addEventListener('click', (e) => { e.stopPropagation(); e.stopImmediatePropagation(); e.preventDefault(); rehostImage(img, link); });
                // Don't mark as attached if src is blank.gif — the API callback may still
                // replace this label with a broken link label once it resolves
                if (!rawSrc.includes('blank.gif')) {
                    img.dataset.rehostAttached = 'true';
                }
                return;
            }
            const isBroken = result.reasons && result.reasons.includes('Broken image');
            const rehostedByCoverup = !isBroken && (link.dataset.rehosted || img.dataset.rehostedUrl);
            const alreadyOnRehostDomain = !isBroken && !rehostedByCoverup && isOnRehostDomain(currentUrl);
            const isOnRedHost = !isBroken && (
                currentUrl.includes('images.redacted.sh') ||
                currentUrl.includes('redacted.sh/i/') ||
                currentUrl.includes('redacted.sh/t/')
            );
            // Already on RED, but as the lower-res /t/ thumbnail rather than the full
            // /i/ image — offer a free upgrade (URL swap only, no re-upload) instead of
            // treating it the same as an already-fine full-size cover. Only worth
            // surfacing when the thumbnail is genuinely tiny on screen — plenty of /t/
            // URLs already render at a fine size, and those should fall through to the
            // normal "already on RED" handling below like they did before this existed.
            const isGenuinelyTinyThumbnail = result.width > 0 && result.height > 0 &&
                result.width <= TINY_THUMBNAIL_MAX && result.height <= TINY_THUMBNAIL_MAX;
            if (!isBroken && isRedThumbnailUrl(currentUrl) && isGenuinelyTinyThumbnail) {
                link.textContent = '[thumbnail only — upgrade to full size?]';
                link.style.color = '#4CAF50';
                link.addEventListener('click', (e) => {
                    e.stopPropagation(); e.stopImmediatePropagation(); e.preventDefault();
                    link.textContent = 'Upgrading…';
                    link.style.color = 'orange';
                    handleUploadSuccess(upgradeRedThumbnailUrl(currentUrl), currentUrl, link, img);
                });
                img.dataset.rehostAttached = 'true';
                return;
            }
            if (rehostedByCoverup || alreadyOnRehostDomain) {
                link.textContent = isOnRedHost
                    ? '[Image hosted on RED — rehost anyway?]'
                    : `[already on ${friendlyHostName(currentUrl)} — redo?]`;
                link.style.color = '#4CAF50';
                link.addEventListener('click', (e) => { e.stopPropagation(); e.stopImmediatePropagation(); e.preventDefault(); rehostImage(img, link); });
                img.dataset.rehostAttached = 'true';
                return;
            }
            if (result.resizeOnly) {
                link.textContent = '[resize & rehost]';
                link.style.color = 'darkorange';
                const reasonSpan = document.createElement('span');
                reasonSpan.textContent = ' - ' + result.reasons.join(', ');
                reasonSpan.style.cssText = 'color:#ffaa44;font-size:0.9em;font-weight:normal;';
                linkDiv.appendChild(reasonSpan);
                link.addEventListener('click', (e) => {
                    e.stopPropagation(); e.stopImmediatePropagation(); e.preventDefault();
                    if (!getRedApiKey() && !getImgbbKey()) { showApiKeySetup(img, link); return; }
                    processImage(getActualImageUrl(img), getActualImageUrl(img), link, img);
                });
            } else if (result.needsRehost) {
                const isBroken = result.reasons.includes('Broken image');
                if (isBroken) {
                    const realUrl = getActualImageUrl(img);
                    link.textContent = '[broken image — rehost?]';
                    link.style.color = '#ff4444';
                    // Show the actual broken image URL, not the torrent page URL
                    const urlSpan = document.createElement('span');
                    urlSpan.style.cssText = 'display:block;font-size:0.78em;font-weight:normal;color:#aaa;word-break:break-all;margin-top:3px;user-select:all;';
                    urlSpan.title = 'Broken image URL';
                    urlSpan.textContent = realUrl;
                    linkDiv.appendChild(urlSpan);
                } else {
                    link.textContent = '[poor quality — rehost?]';
                    link.style.color = 'red';
                    if (result.reasons.length > 0) {
                        const reasonSpan = document.createElement('span');
                        reasonSpan.textContent = ' - ' + result.reasons.join(', ');
                        reasonSpan.style.cssText = 'color:#ff6666;font-size:0.9em;font-weight:normal;';
                        linkDiv.appendChild(reasonSpan);
                    }
                }
                link.addEventListener('click', (e) => {
                    e.stopPropagation(); e.stopImmediatePropagation(); e.preventDefault();
                    rehostImage(img, link);
                });
            } else {
                if (img.dataset.rehostedUrl) {
                    const _url2 = img.dataset.rehostedUrl || img.src || '';
                    const _isRed2 = _url2.includes('redacted.sh/i/') || _url2.includes('redacted.sh/t/') || _url2.includes('images.redacted.sh');
                    const _altUrl2 = img.dataset.rehostedUrl || img.src || '';
                    link.textContent = _isRed2
                        ? '[Image hosted on RED — rehost anyway?]'
                        : `[already on ${friendlyHostName(_altUrl2)} — redo?]`;
                    link.style.color = '#4CAF50';
                } else if (isOnRehostDomain(currentUrl)) {
                    link.textContent = `[already on ${friendlyHostName(getActualImageUrl(img))} — redo?]`;
                    link.style.color = '#4CAF50';
                } else if (isOnSourceDomain(currentUrl)) {
                    let sourceName = '';
                    try {
                        // Turn e.g. "i.discogs.com" → "Discogs", "coverartarchive.org" → "Cover Art Archive"
                        const h = new URL(currentUrl).hostname.replace(/^(i|images?|static|media|cdn)\./, '');
                        const base = h.split('.')[0];
                        const friendly = {
                            'discogs': 'Discogs', 'coverartarchive': 'Cover Art Archive',
                            'musicbrainz': 'MusicBrainz', 'lastfm': 'Last.fm',
                            'qobuz': 'Qobuz', 'mzstatic': 'Apple Music',
                            'archive': 'Archive.org', 'last': 'Last.fm', 'scdn': 'Spotify',
                            'dzcdn': 'Deezer', 'resources': 'Tidal', 'bcbits': 'Bandcamp', 'beatport': 'Beatport',
                        };
                        sourceName = friendly[base] || h;
                    } catch(e) {}
                    link.textContent = sourceName ? `[rehost recommended — hosted on ${sourceName}]` : '[rehost recommended]';
                    link.style.color = 'darkorange';
                } else {
                    link.textContent = `[already on ${friendlyHostName(currentUrl)} — redo?]`;
                    link.style.color = 'green';
                }
                link.addEventListener('click', (e) => { e.stopPropagation(); e.stopImmediatePropagation(); e.preventDefault(); rehostImage(img, link); });
            }
        });

        img.dataset.rehostAttached = 'true';
    }

    coverSelectors.forEach(selector => {
        document.querySelectorAll(selector).forEach(img => attachRehostLink(img));
    });

    // Check if there's a stored image URL in the group's edit form that isn't
    // being rendered visibly (e.g. Gazelle shows blank.gif but the DB has a ptpimg URL).
    // In this case, create a synthetic notice under the Cover heading.
    (function checkHiddenImageUrl() {
        const coversBox = document.querySelector('.box_image_albumart');
        if (!coversBox) return;
        const blankImg = coversBox.querySelector('img[src*="blank.gif"]');
        if (!blankImg) return; // real image is showing, no need

        // Try to find the stored URL — it's in the edit form on the same page
        const imageInput = document.querySelector('input[name="image"]');
        const storedUrl = imageInput ? imageInput.value.trim() : '';
        if (!storedUrl) return; // genuinely no image stored

        // There IS a stored URL but it's not rendering — show a notice
        const noticeDiv = document.createElement('div');
        noticeDiv.style.cssText = 'text-align:center;margin:6px 0 4px;font-size:0.9em;';

        const link = document.createElement('a');
        link.href = 'javascript:void(0)';
        link.style.cssText = 'font-weight:bold;cursor:pointer;';

        // Determine the right label based on the stored URL
        const isPtpimg  = storedUrl.includes('ptpimg.me');
        const isRedHost = storedUrl.includes('redacted.sh/i/') || storedUrl.includes('redacted.sh/t/') || storedUrl.includes('images.redacted.sh');
        const isRehost  = ['imgbb.com','catbox.moe','ra.thesungod.xyz','ibb.co'].some(d => storedUrl.includes(d));

        if (isPtpimg) {
            link.textContent = '[broken ptpimg link — rehost?]';
            link.style.color = '#ff4444';
        } else if (isRedHost) {
            link.textContent = "[Image hosted on RED — rehost anyway?]";
            link.style.color = '#4CAF50';
        } else if (isRehost) {
            link.textContent = `[already on ${friendlyHostName(storedUrl)} — redo?]`;
            link.style.color = '#4CAF50';
        } else {
            link.textContent = `[broken ${friendlyHostName(storedUrl)} link — rehost?]`;
            link.style.color = '#ff4444';
        }

        // Show the stored URL below
        const urlSpan = document.createElement('div');
        urlSpan.style.cssText = 'font-size:0.78em;color:#aaa;word-break:break-all;margin-top:2px;user-select:all;';
        urlSpan.textContent = storedUrl;

        link.onclick = (e) => {
            e.preventDefault();
            // Use the stored URL as the "current image" for the picker
            blankImg.dataset.rehostOldUrl = storedUrl;
            rehostImage(blankImg, link);
        };

        noticeDiv.appendChild(link);
        noticeDiv.appendChild(urlSpan);

        // Insert after the blank img's parent p
        const parentP = blankImg.closest('p') || blankImg.parentNode;
        parentP.parentNode.insertBefore(noticeDiv, parentP.nextSibling);
    })();

    // Gazelle's cover_art.js replaces blank.gif src values after page load.
    // Watch for those src changes AND do a delayed re-scan after load fires.
    const _lazyObserver = new MutationObserver(mutations => {
        mutations.forEach(m => {
            if (m.type === 'attributes' && m.attributeName === 'src') {
                const img = m.target;
                const src = img.getAttribute('src') || '';
                if (!src.includes('blank.gif') && !img.dataset.rehostAttached) {
                    attachRehostLink(img);
                }
            }
        });
    });
    function observeCovers() {
        coverSelectors.forEach(selector => {
            document.querySelectorAll(selector).forEach(img => {
                if (!img.dataset.rehostAttached) {
                    _lazyObserver.observe(img, { attributes: true, attributeFilter: ['src'] });
                }
            });
        });
    }
    observeCovers();

    // Also observe #covers container for subtree changes — catches cases where
    // Gazelle replaces the whole img element rather than just changing src
    const coversContainer = document.getElementById('covers');
    if (coversContainer) {
        new MutationObserver(() => { rescanCovers(); })
            .observe(coversContainer, { subtree: true, childList: true, attributes: true, attributeFilter: ['src'] });
    }

    // Re-scan after page fully loads (cover_art.js may have already run by then)
    function rescanCovers() {
        coverSelectors.forEach(selector => {
            document.querySelectorAll(selector).forEach(img => {
                const src = img.getAttribute('src') || '';
                if (!src.includes('blank.gif') && !img.dataset.rehostAttached) {
                    attachRehostLink(img);
                }
            });
        });
    }
    window.addEventListener('load', () => { rescanCovers(); });
    setTimeout(rescanCovers, 500);
    setTimeout(rescanCovers, 1500);
    setTimeout(rescanCovers, 3000);

    // Alt cover rehost links: hide by default, show a summary nudge instead.
    // Reveal everything when the user clicks "Show all" (Gazelle's own button).
    (function setupAltCoverLinks() {
        const firstAltCoverDiv = document.getElementById('cover_div_1');
        if (!firstAltCoverDiv) return;
        const coversContainer = firstAltCoverDiv.parentNode;

        // Collect all rehost-link-wrappers that belong to alt covers (not cover_div_0)
        const altWrappers = Array.from(coversContainer.querySelectorAll('.rehost-link-wrapper'))
            .filter(w => {
                const cd = w.nextElementSibling || w.previousElementSibling;
                return cd && cd.id !== 'cover_div_0';
            });

        if (!altWrappers.length) return;

        // Hide all alt cover rehost links initially
        altWrappers.forEach(w => { w.dataset.coverupHidden = '1'; w.style.display = 'none'; });

        // Count how many need attention (anything that isn't "already rehosted")
        function countNeedingAttention() {
            return altWrappers.filter(w => {
                const a = w.querySelector('a');
                if (!a) return false;
                const t = a.textContent;
                return !t.startsWith('[already on ') && !t.includes('handsome devil') && t !== '[checking...]';
            }).length;
        }

        // Build the summary label
        const summaryDiv = document.createElement('div');
        summaryDiv.id = 'coverup-alt-summary';
        summaryDiv.style.cssText = 'text-align:center;font-size:0.85em;color:#aaa;margin:6px 0 4px;';

        function revealAll() {
            altWrappers.forEach(w => { w.style.display = ''; });
            summaryDiv.style.display = 'none';
        }

        function updateSummary() {
            const total = altWrappers.length;
            const needsWork = countNeedingAttention();
            summaryDiv.innerHTML = '';
            if (needsWork > 0) {
                const msg = document.createElement('span');
                msg.style.color = '#ffaa44';
                msg.textContent = `${needsWork} of ${total} alternate cover${total > 1 ? 's' : ''} may need rehosting `;
                summaryDiv.appendChild(msg);
            } else {
                const msg = document.createElement('span');
                msg.textContent = `${total} alternate cover${total > 1 ? 's' : ''} `;
                summaryDiv.appendChild(msg);
            }
            const showLink = document.createElement('a');
            showLink.href = '#';
            showLink.textContent = '[Show all]';
            showLink.style.cssText = 'color:#7ab8ff;font-weight:bold;';
            showLink.addEventListener('click', e => { e.preventDefault(); revealAll(); });
            summaryDiv.appendChild(showLink);
        }

        // Show a placeholder while image probes run, then update with real count
        summaryDiv.textContent = 'Checking alternate covers…';
        setTimeout(updateSummary, 7000);

        // Insert summary before the first alt rehost wrapper (or firstAltCoverDiv)
        const firstWrapper = altWrappers[0];
        coversContainer.insertBefore(summaryDiv, firstWrapper);

        // Also hook Gazelle's own "Show all" button so both paths work
        document.querySelectorAll('.show_all_covers').forEach(btn => {
            btn.addEventListener('click', revealAll, { once: true });
        });
    })();

    // ============================================================
    // --- AUTO-RESUME ---
    // ============================================================

    const pendingImgSrc = sessionStorage.getItem('rehost_pending_src');
    if (pendingImgSrc && (getRedApiKey() || getImgbbKey())) {
        setTimeout(() => {
            const allImgs   = document.querySelectorAll(coverSelectors.join(','));
            const targetImg = Array.from(allImgs).find(img => img.src === pendingImgSrc);
            if (targetImg) {
                const cont = targetImg.closest('p') || targetImg.parentNode;
                const link = cont.querySelector('.rehost-link-wrapper a');
                if (link) { sessionStorage.removeItem('rehost_pending_src'); rehostImage(targetImg, link); }
            }
        }, 1000);
    }

    // ============================================================
    // --- AUTO-SUBMIT ON EDIT PAGE ---
    // ============================================================

    if (window.location.href.includes('action=editgroup')) {
        const oldUrl = sessionStorage.getItem('red_rehost_old_url');
        const newUrl = sessionStorage.getItem('red_rehost_new_url');
        if (newUrl) {
            sessionStorage.removeItem('red_rehost_old_url');
            sessionStorage.removeItem('red_rehost_new_url');
            // Fill the primary cover image input
            const imageInput = document.querySelector('input[name="image"]');
            const textarea   = document.querySelector('textarea[name="body"]') || document.querySelector('textarea#body');
            if (imageInput) { imageInput.value = newUrl; imageInput.style.backgroundColor = '#ffffcc'; }
            if (textarea && oldUrl && textarea.value.includes(oldUrl)) {
                textarea.value = textarea.value.replace(
                    new RegExp(oldUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), newUrl
                );
                textarea.style.backgroundColor = '#ffffcc';
            }
            setTimeout(function() {
                const summaryInput = document.querySelector('input[name="summary"]');
                if (summaryInput) summaryInput.value = 'Rehosted cover image';
                const form = document.querySelector('form[name="torrent_group"]') || document.querySelector('form');
                if (form) form.submit();
            }, 400);
        }
    }

    // ============================================================
    // --- API SETUP PROMPT ---
    // ============================================================

    function showApiKeySetup(img, link) {
        const redKey = prompt('No image hosting API key found.\n\nEnter your RED API key (from your RED user settings → API Keys):\n\n(Leave blank to choose a fallback host instead)');
        if (redKey && redKey.trim()) {
            setRedApiKey(redKey.trim());
        }
        rehostImage(img, link);
    }

    // ============================================================
    // --- CORE REHOST LOGIC ---
    // ============================================================

    function rehostImage(img, link) {
        const oldUrl    = img.src;
        const albumInfo = parseAlbumInfo();

        function openPicker() {
            createImagePickerOverlay(albumInfo, (selectedUrl) => {
                if (!selectedUrl) {
                    link.textContent = '[poor quality — rehost?]';
                    link.style.color = 'red';
                } else if (selectedUrl === 'SKIP') {
                    checkAndProcess(img, oldUrl, link);
                } else if (selectedUrl.startsWith('__localfile__:')) {
                    const objectUrl = selectedUrl.slice('__localfile__:'.length);
                    link.textContent = 'Processing...';
                    link.style.color = 'orange';
                    fetch(objectUrl)
                        .then(r => r.blob())
                        .then(blob => {
                            URL.revokeObjectURL(objectUrl);
                            const tempImg = new Image();
                            const blobUrl = URL.createObjectURL(blob);
                            tempImg.onload = function() {
                                let w = tempImg.width, h = tempImg.height;
                                if (w > MAX_DIMENSION || h > MAX_DIMENSION) {
                                    const ratio = Math.min(MAX_DIMENSION / w, MAX_DIMENSION / h);
                                    w = Math.round(w * ratio); h = Math.round(h * ratio);
                                }
                                const canvas = document.createElement('canvas');
                                canvas.width = w; canvas.height = h;
                                const ctx = canvas.getContext('2d');
                                ctx.fillStyle = '#FFFFFF';
                                ctx.fillRect(0, 0, w, h);
                                ctx.drawImage(tempImg, 0, 0, w, h);
                                URL.revokeObjectURL(blobUrl);
                                canvas.toBlob(jpegBlob => {
                                    link.textContent = 'Uploading...';
                                    link.style.color = 'orange';
                                    uploadWithFallback(jpegBlob, oldUrl, link, newUrl => handleUploadSuccess(newUrl, oldUrl, link, img));
                                }, 'image/jpeg', JPEG_QUALITY);
                            };
                            tempImg.src = blobUrl;
                        })
                        .catch(() => { link.textContent = 'File read failed'; link.style.color = 'red'; });
                } else if (selectedUrl.startsWith('__customurl__:')) {
                    // Manually pasted URL — the user explicitly asked us to rehost this
                    // image, so always fetch + re-upload it to RED, regardless of which
                    // domain it came from. Only skip re-upload if it's already sitting on
                    // one of our own permanent rehost hosts (RED/imgbb/catbox/TheSunGod).
                    const rawUrl = selectedUrl.slice('__customurl__:'.length);
                    if (isOnRehostDomain(rawUrl)) {
                        link.textContent = 'Saving…';
                        link.style.color = 'orange';
                        handleUploadSuccess(rawUrl, oldUrl, link, img);
                    } else {
                        processImage(rawUrl, oldUrl, link, img);
                    }
                } else {
                    // If the URL is a direct image link, use it as-is without re-uploading.
                    // Only re-upload if it comes from a source that needs processing
                    // (streaming services, page URLs, Apple Music, etc.)
                    const needsReupload = NEEDS_CLIENT_FETCH_RE.test(selectedUrl);
                    if (!needsReupload) {
                        link.textContent = 'Saving…';
                        link.style.color = 'orange';
                        handleUploadSuccess(selectedUrl, oldUrl, link, img);
                    } else {
                        processImage(selectedUrl, oldUrl, link, img);
                    }
                }
            });
        }

        // ptpimg.me is permanently dead, but RED's own upload-by-URL endpoint can often
        // still recover the image — it appears to check its own cache/history before
        // attempting a live fetch of the dead source. Try that first for any ptpimg URL:
        // a single fast API call, versus opening the full multi-source artwork picker.
        // Falls straight through to the picker as before if recovery doesn't pan out.
        const detectedUrl = img.dataset.rehostOldUrl || getActualImageUrl(img) || oldUrl;
        const apiKey = getRedApiKey();
        if (detectedUrl && detectedUrl.includes('ptpimg.me') && apiKey) {
            link.textContent = 'Recovering from RED cache…';
            link.style.color = 'orange';
            uploadUrlToRed(detectedUrl, apiKey).then(recoveredUrl => {
                if (recoveredUrl) {
                    handleUploadSuccess(recoveredUrl, oldUrl, link, img);
                } else {
                    link.textContent = '[broken ptpimg link — rehost?]';
                    link.style.color = 'red';
                    openPicker();
                }
            });
            return;
        }

        openPicker();
    }

    function checkAndProcess(img, oldUrl, link) {
        const needsProcessing = oldUrl.includes('apple.com') || oldUrl.includes('mzstatic.com') ||
                                !oldUrl.toLowerCase().match(/\.jpe?g/) || img.naturalWidth > MAX_DIMENSION;
        if (needsProcessing) processImage(oldUrl, oldUrl, link, img);
        else fetchAndUpload(oldUrl, oldUrl, link, img);
    }

    function processImage(imageUrl, oldUrl, link, img) {
        link.textContent = 'Processing...';
        link.style.color = 'orange';
        // Some CDNs (e.g. Spotify) serve images without a file extension.
        // Append a hint so the fetch is treated as an image blob.
        const fetchUrl = imageUrl;
        GM_xmlhttpRequest({
            method: 'GET', url: fetchUrl, responseType: 'blob',
            headers: { 'Accept': 'image/jpeg,image/png,image/*,*/*' },
            // This fetch previously had no timeout at all — unlike almost every other
            // network call in the script. A source host that accepts the connection
            // but never responds (small/personal hosts like TheSunGod are the likely
            // case) would hang here forever with no error, no fallback, and no way to
            // recover — exactly what "stuck on the same cover every time" looks like.
            timeout: 20000,
            onload: function(response) {
                const tempImg   = new Image();
                const objectUrl = URL.createObjectURL(response.response);
                tempImg.onload  = function() {
                    let w = tempImg.width, h = tempImg.height;
                    if (w > MAX_DIMENSION || h > MAX_DIMENSION) {
                        const ratio = Math.min(MAX_DIMENSION / w, MAX_DIMENSION / h);
                        w = Math.round(w * ratio); h = Math.round(h * ratio);
                    }
                    const canvas = document.createElement('canvas');
                    canvas.width = w; canvas.height = h;
                    const ctx = canvas.getContext('2d');
                    ctx.fillStyle = '#FFFFFF';
                    ctx.fillRect(0, 0, w, h);
                    ctx.drawImage(tempImg, 0, 0, w, h);
                    canvas.toBlob(blob => {
                        URL.revokeObjectURL(objectUrl);
                        link.textContent = 'Uploading...';
                        link.style.color = 'orange';
                        uploadWithFallback(blob, oldUrl, link, newUrl => handleUploadSuccess(newUrl, oldUrl, link, img));
                    }, 'image/jpeg', JPEG_QUALITY);
                };
                // The fetch succeeding doesn't guarantee the bytes are a decodable
                // image — a source host can return an HTML error page, a truncated
                // file, etc. Without this, that case hung forever too (tempImg.onload
                // simply never fires, and there was nothing else waiting on it).
                tempImg.onerror = function() {
                    URL.revokeObjectURL(objectUrl);
                    link.textContent = 'Invalid image data';
                    link.style.color = 'red';
                };
                tempImg.src = objectUrl;
            },
            onerror:   function() { link.textContent = 'Fetch failed';   link.style.color = 'red'; },
            ontimeout: function() { link.textContent = 'Fetch timed out'; link.style.color = 'red'; }
        });
    }

    function fetchAndUpload(imageUrl, oldUrl, link, img) {
        link.textContent = 'Uploading...';
        link.style.color = 'orange';
        GM_xmlhttpRequest({
            method: 'GET', url: imageUrl, responseType: 'blob',
            timeout: 20000,
            onload: function(response) {
                uploadWithFallback(response.response, oldUrl, link, newUrl => handleUploadSuccess(newUrl, oldUrl, link, img));
            },
            onerror:   function() { link.textContent = 'Fetch failed';   link.style.color = 'red'; },
            ontimeout: function() { link.textContent = 'Fetch timed out'; link.style.color = 'red'; }
        });
    }


    // ============================================================
    // --- COVER TYPE DETECTION ---
    // ============================================================

    // Returns { isPrimary, coverArtId, groupId }
    // isPrimary = true  → lives in #cover_div_0 (the main cover, edit via editgroup)
    // isPrimary = false → alternative cover; coverArtId is extracted from its remove link
    function getCoverInfo(img) {
        const coverDiv = img.closest('[id^="cover_div_"]');
        if (!coverDiv) return { isPrimary: true, coverArtId: null, groupId: null };

        const isPrimary = coverDiv.id === 'cover_div_0';

        if (isPrimary) return { isPrimary: true, coverArtId: null, groupId: null };

        // Extract coverArtId and groupId from the remove link in this div
        // The remove link has href="#" but the action URL is inside the onclick attribute:
        // onclick="...ajax.get('torrents.php?action=remove_cover_art&auth=...&id=3973&groupid=3061')..."
        let coverArtId = null, groupId = null;
        const allLinks = coverDiv.querySelectorAll('a');
        let removeOnclick = '';
        allLinks.forEach(function(a) {
            const oc = a.getAttribute('onclick') || '';
            if (oc.includes('remove_cover_art')) removeOnclick = oc;
        });
        let authToken = null;
        if (removeOnclick) {
            const idMatch      = removeOnclick.match(/[?&]id=(\d+)/);
            const groupIdMatch = removeOnclick.match(/[?&]groupid=(\d+)/);
            const authMatch    = removeOnclick.match(/[?&]auth=([a-f0-9]+)/i);
            if (idMatch)      coverArtId = idMatch[1];
            if (groupIdMatch) groupId    = groupIdMatch[1];
            if (authMatch)    authToken  = authMatch[1];
        }
        // Fallback: groupId from page URL
        if (!groupId) {
            const urlMatch = window.location.href.match(/[?&]id=(\d+)/);
            if (urlMatch) groupId = urlMatch[1];
        }

        return { isPrimary: false, coverArtId, groupId, authToken };
    }

    function handleUploadSuccess(newUrl, oldUrl, link, img) {
        GM_setClipboard(newUrl);
        link.dataset.rehosted = '1';
        setRehostedUrl(oldUrl, newUrl);
        setRehostedUrl(newUrl, 'self');
        document.querySelectorAll(coverSelectors.join(',')).forEach(function(el) {
            if (el.src === oldUrl || el.dataset.rehostOldUrl === oldUrl) {
                el.dataset.rehostedUrl = newUrl;
            }
        });

        if (!/torrents\.php/.test(window.location.pathname)) {
            link.textContent = 'Uploaded — URL copied (auto-save only works on a torrent group page)';
            link.style.color = '#4CAF50';
            return;
        }

        const coverInfo = img ? getCoverInfo(img) : { isPrimary: true };
        const groupIdMatch = window.location.href.match(/[?&]id=(\d+)/);
        const groupId = groupIdMatch ? groupIdMatch[1] : null;
        if (!groupId) return;

        if (coverInfo.isPrimary) {
            // Primary cover: must use editgroup form (no AJAX endpoint to update it)
            sessionStorage.setItem('red_rehost_old_url', oldUrl);
            sessionStorage.setItem('red_rehost_new_url', newUrl);
            link.textContent = 'Saving…';
            link.style.color = 'orange';
            window.location.href = 'torrents.php?action=editgroup&groupid=' + groupId;
            return;
        }

        // Alt cover: use AJAX add + remove, no page redirect needed
        if (!coverInfo.coverArtId || !coverInfo.authToken) {
            // Fallback: try to get auth from page-level JS var
            const pageAuth = (typeof authkey !== 'undefined') ? authkey : null;
            if (!pageAuth) {
                alert('Cover uploaded!\nCould not detect auth token — paste manually:\n\n' + newUrl);
                return;
            }
            coverInfo.authToken = pageAuth;
        }

        link.textContent = 'Saving…';
        link.style.color = 'orange';

        const coverDiv  = img ? img.closest('[id^="cover_div_"]') : null;
        // Use release metadata summary if set by Discogs picker (e.g. "UK, 1970"),
        // otherwise fall back to the existing img.alt attribute
        const coverTitle = (img && img.dataset && img.dataset.coverupSummary)
            ? img.dataset.coverupSummary
            : (img && img.alt) ? img.alt : '';
        if (img && img.dataset) delete img.dataset.coverupSummary; // consume it

        // Step 1: Fetch the live page to find the real input field names for add_cover_art.
        // Gazelle's cover_art.js adds image/summary fields dynamically — we need their names
        // from the live DOM, not from a POST response.
        GM_xmlhttpRequest({
            method: 'GET',
            url: 'torrents.php?id=' + (coverInfo.groupId || groupId),
            onload: function(pageResp) {
                const parser = new DOMParser();
                const livePage = parser.parseFromString(pageResp.responseText, 'text/html');

                // Find image and summary field names from the live page
                // They sit near the add_cover div — look for text/url inputs adjacent to it
                let imageFieldName = 'image';
                let summaryFieldName = 'summary';
                const addCoverDiv = livePage.getElementById('add_cover');
                if (addCoverDiv) {
                    // Walk up to find sibling/parent inputs
                    const container = addCoverDiv.closest('form') || addCoverDiv.parentNode;
                    if (container) {
                        const textInputs = container.querySelectorAll('input[type="text"], input:not([type])');
                        textInputs.forEach(inp => {
                            const n = (inp.name || '').toLowerCase();
                            const p = (inp.placeholder || '').toLowerCase();
                            if (n.includes('image') || n.includes('url') || p.includes('image') || p.includes('url') || n === 'image') {
                                imageFieldName = inp.name;
                            }
                            if (n.includes('summary') || n.includes('title') || n.includes('caption') || p.includes('summary')) {
                                summaryFieldName = inp.name;
                            }
                        });
                    }
                }
                // Field names confirmed by inspecting addCoverField() output:
                // Redacted uses array notation: image[] and summary[]

                // Send as multipart FormData — Redacted uses image[]/summary[] array fields
                const addFormData = new FormData();
                addFormData.append('action',   'add_cover_art');
                addFormData.append('auth',     coverInfo.authToken);
                addFormData.append('groupid',  coverInfo.groupId || groupId);
                addFormData.append('image[]',  newUrl);
                addFormData.append('summary[]', coverTitle || 'Rehosted cover');


                // Step 2: GET remove_cover_art to delete the old entry FIRST.
                const removeUrl = 'torrents.php?action=remove_cover_art'
                    + '&auth='    + encodeURIComponent(coverInfo.authToken)
                    + '&id='      + encodeURIComponent(coverInfo.coverArtId)
                    + '&groupid=' + encodeURIComponent(coverInfo.groupId || groupId);

                GM_xmlhttpRequest({
                    method: 'GET',
                    url:    removeUrl,
                    onload: function(removeResp) {
                        console.log('[CoverUp] remove_cover_art status:', removeResp.status);

                        // Step 3: POST add_cover_art as multipart FormData

                GM_xmlhttpRequest({
                    method: 'POST',
                    url:    'torrents.php',
                    data:   addFormData,
                    onload: function(addResp) {
                        console.log('[CoverUp] add_cover_art status:', addResp.status);
                        console.log('[CoverUp] add_cover_art finalUrl:', addResp.finalUrl);
                        console.log('[CoverUp] add_cover_art response length:', addResp.responseText.length);
                        console.log('[CoverUp] add_cover_art newUrl present in response:', addResp.responseText.includes(newUrl));
                        console.log('[CoverUp] add_cover_art response (first 500 chars):', addResp.responseText.slice(0, 500));

                        // Parse the response page to find the add_cover_art form fields
                        // and any error messages — this tells us what Gazelle actually expects
                        try {
                            const parser = new DOMParser();
                            const doc = parser.parseFromString(addResp.responseText, 'text/html');
                            // Find any error notices
                            const notices = doc.querySelectorAll('.error, .notice, #notice, .alertbar');
                            notices.forEach(n => console.log('[CoverUp] Page notice:', n.textContent.trim().slice(0, 200)));
                            // Find the add cover art form and log all its fields
                            const forms = doc.querySelectorAll('form');
                            forms.forEach(form => {
                                const action = form.getAttribute('action') || '';
                                const inputs = Array.from(form.querySelectorAll('input, textarea, select'));
                                const hasAddCover = inputs.some(i => (i.value || '').includes('add_cover')) ||
                                                    action.includes('add_cover') ||
                                                    form.innerHTML.includes('add_cover_art');
                                if (hasAddCover || form.innerHTML.includes('cover')) {
                                    console.log('[CoverUp] Cover form action:', action);
                                    console.log('[CoverUp] Cover form HTML:', form.innerHTML.slice(0, 1200));
                                    inputs.forEach(i => {
                                        console.log('[CoverUp] Form field:', i.type, '|', i.name || '(no name)', '=', (i.value || '').slice(0, 100));
                                    });
                                }
                            });
                        } catch(e) { console.log('[CoverUp] Form parse error:', e.message); }
                        console.log('[CoverUp] Alt cover rehosted successfully:', newUrl);

                        if (addResp.status < 200 || addResp.status >= 400) {
                            link.textContent = '[add failed (HTTP ' + addResp.status + ') — old entry already removed!]';
                            link.style.color = '#f44';
                            console.error('[CoverUp] add_cover_art returned HTTP', addResp.status);
                            return;
                        }

                        link.textContent = '✓ Saved — reloading…';
                        link.style.color = '#4CAF50';
                        setTimeout(function() { location.reload(); }, 800);
                    },
                    onerror: function() {
                        link.textContent = '[add failed — old entry already removed!]';
                        link.style.color = '#f44';
                        console.error('[CoverUp] add_cover_art POST failed');
                    }
                });
            },
            onerror: function() {
                link.textContent = '[remove failed — add not attempted, old entry kept]';
                link.style.color = '#f44';
                console.error('[CoverUp] remove_cover_art GET failed');
            }
                });
            },
            onerror: function() {
                link.textContent = '[could not load page to detect form fields]';
                link.style.color = '#f44';
                console.error('[CoverUp] live page fetch failed');
            }
        });
    }

})();
