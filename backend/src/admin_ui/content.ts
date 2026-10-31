// The Content section of the admin dashboard: theme images and sticker packs for the Personalization Studio. It is spliced
// into the dashboard script (see script.ts), so it shares that script's helpers (h, api, body, clear, fail, pill, field,
// cursorList, confirmButton ...). Same rules as the rest of the dashboard: no template literals, no innerHTML, everything built
// with textContent. The API enforces every permission and every rule (rights, sizes, formats); this page only collects input.
export const CONTENT_JS = String.raw`
  // =====================================================================================================
  // Content: theme images and sticker packs
  // =====================================================================================================
  ICONS.themeimages = 'M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4';
  ICONS.stickerpacks = 'M6 4h12a2 2 0 0 1 2 2v8l-6 6H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM20 14h-4a2 2 0 0 0-2 2v4';

  PAGES.themeimages = { title: 'Theme images', group: 'Studio', cap: 'personalization.manage', desc: 'Wallpapers and theme pictures students can browse in Themes Studio. Add only images you made or have a licence for. Nothing is visible to students until you publish it.', view: viewThemeImages };
  PAGES.stickerpacks = { title: 'Sticker packs', group: 'Studio', cap: 'personalization.manage', desc: 'Create sticker packs, add stickers (several at once), put them in order and publish. Stickers must be PNG or WebP with a transparent background, up to 512 KB each.', view: viewStickerPacks };
  NAV.splice(4, 0, ['Studio', ['themeimages', 'stickerpacks']]);

  var CONTENT_LICENSES = [['univibe_original', 'Made by UniVibe'], ['licensed_provider', 'Licensed from a provider'], ['creator_submission', 'Submitted by a creator (with permission)']];
  var STICKER_CATEGORIES = [['campus_vibes', 'Campus vibes'], ['funny_reactions', 'Funny reactions'], ['emotions', 'Emotions'], ['love_friendship', 'Love and friendship'], ['study_mode', 'Study mode'], ['tech_gaming', 'Tech and gaming'], ['univibe_originals', 'UniVibe originals'], ['seasonal', 'Seasonal']];
  var THEME_DESTINATIONS = [['profile_cover', 'Profile cover'], ['chat_background', 'Chat background'], ['story_background', 'Story background'], ['note_background', 'Note background']];

  // ---------- helpers
  function selectOf(options, id) {
    var s = h('select', { id: id });
    options.forEach(function (o) { s.appendChild(h('option', { value: o[0] }, o[1])); });
    return s;
  }
  // The file goes straight to storage through a short-lived signed link, then the server checks what actually arrived.
  function uploadFile(file, purpose) {
    // The photo goes to our own server (which stores it), then the server checks it: no direct browser-to-storage step.
    return api('POST', '/media/uploads', { kind: 'image', purpose: purpose, contentType: file.type, size: file.size }).then(function (u) {
      return api('PUT', '/media/' + u.mediaId + '/content', file).then(function () {
        return api('POST', '/media/' + u.mediaId + '/complete', {});
      }).then(function () { return u.mediaId; });
    });
  }
  function slugOf(name) {
    var s = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').replace(/-+$/, '');
    return s.slice(0, 60).replace(/-+$/, '');
  }
  function labelOf(fileName) {
    var s = String(fileName || '').replace(/[.][a-zA-Z0-9]+$/, '').replace(/[-_]+/g, ' ').replace(/^ +/, '').replace(/ +$/, '');
    return (s || 'Sticker').slice(0, 40);
  }
  function thumb(url, alt, size) {
    return url ? h('img', { src: url, alt: alt || '', width: size, height: size, loading: 'lazy' }) : h('span', { class: 'small muted' }, 'no preview');
  }
  function showMsg(el, text, isErr) { el.textContent = text; el.className = 'small' + (isErr ? ' err' : ''); }
  function checkbox(id, label) {
    var c = h('input', { type: 'checkbox', id: id });
    return { box: c, row: h('label', { class: 'row' }, c, h('span', null, label)) };
  }

  // =====================================================================================================
  // Theme images
  // =====================================================================================================
  function viewThemeImages() {
    var out = h('div'); body.appendChild(out);
    var status = 'draft', holder = h('div'), tabs = h('div', { class: 'row seg' });

    var file = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', 'aria-label': 'Image file' });
    var title = h('input', { type: 'text', maxlength: 80, size: 30, 'aria-label': 'Title' });
    var desc = h('input', { type: 'text', maxlength: 500, size: 40, 'aria-label': 'Description' });
    var source = h('input', { type: 'text', maxlength: 200, size: 40, placeholder: 'Who made it, or where it is licensed from', 'aria-label': 'Source' });
    var category = selectOf([['', 'Loading categories...']], 'ti-cat');
    var license = selectOf(CONTENT_LICENSES, 'ti-license');
    var premium = checkbox('ti-premium', 'Premium (only people with Premium can save or use it; everyone can preview)');
    var rights = checkbox('ti-rights', 'I made this image or have the right to distribute it inside UniVibe.');
    var dests = THEME_DESTINATIONS.map(function (d) { var c = checkbox('ti-d-' + d[0], d[1]); c.box.checked = true; c.key = d[0]; return c; });
    var msg = h('div', { role: 'status', class: 'small' });
    var submit = h('button', { class: 'btn', type: 'button' }, 'Upload as draft');

    api('GET', '/personalization/categories').then(function (d) {
      clear(category);
      d.categories.forEach(function (c) { category.appendChild(h('option', { value: c.slug }, c.name)); });
    }).catch(function (e) { showMsg(msg, e.message, true); });

    submit.addEventListener('click', function () {
      var f = file.files && file.files[0];
      if (!f) return showMsg(msg, 'Choose an image first.', true);
      if (['image/jpeg', 'image/png', 'image/webp'].indexOf(f.type) < 0) return showMsg(msg, 'Use a JPEG, PNG or WebP image.', true);
      if (title.value.trim().length < 2) return showMsg(msg, 'Give it a title (at least 2 letters).', true);
      if (source.value.trim().length < 2) return showMsg(msg, 'Say where the image comes from.', true);
      if (!rights.box.checked) return showMsg(msg, 'Tick the box to confirm you have the rights to this image.', true);
      var chosen = dests.filter(function (c) { return c.box.checked; }).map(function (c) { return c.key; });
      if (!chosen.length) return showMsg(msg, 'Pick at least one place it can be used.', true);
      submit.disabled = true; showMsg(msg, 'Uploading...', false);
      uploadFile(f, 'cover').then(function (mediaId) {
        showMsg(msg, 'Saving...', false);
        return api('POST', '/admin/personalization/assets', {
          mediaId: mediaId, categorySlug: category.value, title: title.value.trim(), description: desc.value.trim(),
          sourceAttribution: source.value.trim(), license: license.value, premium: premium.box.checked, destinations: chosen,
        });
      }).then(function () {
        submit.disabled = false; file.value = ''; title.value = ''; desc.value = ''; rights.box.checked = false;
        showMsg(msg, 'Saved as a draft. Check it below, then publish it.', false);
        status = 'draft'; show();
      }).catch(function (e) { submit.disabled = false; showMsg(msg, e.message, true); });
    });

    out.appendChild(h('h2', null, 'Add an image'));
    out.appendChild(h('div', { class: 'card' },
      field('Image', file), field('Title', title), field('Category', category), field('Description', desc), field('Source', source),
      field('Licence', license), premium.row, h('div', { class: 'small muted' }, 'Where it can be used:'), dests.map(function (c) { return c.row; }),
      rights.row, h('div', { class: 'row' }, submit), msg));

    out.appendChild(h('h2', null, 'Images'));
    out.appendChild(tabs); out.appendChild(holder);

    function show() {
      clear(tabs); clear(holder);
      [['draft', 'Drafts'], ['published', 'Published'], ['unpublished', 'Unpublished'], ['removed', 'Removed']].forEach(function (o) {
        tabs.appendChild(h('button', { class: 'tab' + (status === o[0] ? ' on' : ''), type: 'button', onclick: function () { status = o[0]; show(); } }, o[1]));
      });
      cursorList(holder, '/admin/personalization/assets', { status: status }, function (x, reload) {
        function setStatus(to) { return function () { return api('PATCH', '/admin/personalization/assets/' + x.id + '/status', { status: to }).then(reload); }; }
        var actions = h('div', { class: 'row' });
        if (x.status !== 'published' && x.status !== 'removed') actions.appendChild(confirmButton('Publish', 'Publish "' + x.title + '"? Students will see it straight away.', setStatus('published'), false));
        if (x.status === 'published') actions.appendChild(confirmButton('Unpublish', 'Unpublish "' + x.title + '"? It disappears from Themes Studio. People who already use it keep it until they change it.', setStatus('unpublished'), true));
        if (x.status !== 'removed') actions.appendChild(confirmButton('Remove for good', 'Remove "' + x.title + '"? This cannot be undone.', setStatus('removed'), true));
        return h('div', { class: 'card' }, h('div', { class: 'row' }, thumb(x.thumbUrl, x.title, 72),
          h('div', null, h('b', null, x.title), ' ', pill(x.status), x.premium ? pill('premium') : null,
            h('div', { class: 'small muted' }, x.category + ' - ' + words(x.license)),
            h('div', { class: 'small muted' }, 'Source: ' + x.sourceAttribution),
            h('div', { class: 'small muted' }, 'Used for: ' + x.destinations.map(words).join(', ')))), actions);
      }, 'Nothing here yet.');
    }
    show();
  }

  // =====================================================================================================
  // Sticker packs
  // =====================================================================================================
  function viewStickerPacks() {
    var out = h('div'); body.appendChild(out);
    function showList() { clear(out); drawList(); }
    function openPack(id) { clear(out); drawPack(id); }

    function drawList() {
      var status = 'draft', holder = h('div'), tabs = h('div', { class: 'row seg' });
      var cover = h('input', { type: 'file', accept: 'image/png,image/webp', 'aria-label': 'Pack cover' });
      var name = h('input', { type: 'text', maxlength: 60, size: 30, 'aria-label': 'Pack name' });
      var slug = h('input', { type: 'text', maxlength: 60, size: 30, 'aria-label': 'Pack address', placeholder: 'campus-life' });
      var desc = h('input', { type: 'text', maxlength: 300, size: 40, 'aria-label': 'Description' });
      var category = selectOf(STICKER_CATEGORIES, 'sp-cat');
      var license = selectOf(CONTENT_LICENSES, 'sp-license');
      var source = h('input', { type: 'text', maxlength: 200, size: 40, placeholder: 'Who drew them, or where they are licensed from', 'aria-label': 'Source' });
      var premium = checkbox('sp-premium', 'Premium pack');
      var rights = checkbox('sp-rights', 'I made these stickers or have the right to distribute them inside UniVibe. They do not copy anyone else\'s characters, logos or artwork.');
      var msg = h('div', { role: 'status', class: 'small' }), submit = h('button', { class: 'btn', type: 'button' }, 'Create pack');
      var slugEdited = false;
      slug.addEventListener('input', function () { slugEdited = true; });
      name.addEventListener('input', function () { if (!slugEdited) slug.value = slugOf(name.value); });

      submit.addEventListener('click', function () {
        var f = cover.files && cover.files[0];
        if (!f) return showMsg(msg, 'Choose a cover picture (PNG or WebP).', true);
        if (['image/png', 'image/webp'].indexOf(f.type) < 0) return showMsg(msg, 'The cover must be a PNG or WebP with a transparent background.', true);
        if (name.value.trim().length < 2) return showMsg(msg, 'Give the pack a name.', true);
        if (slug.value.length < 3) return showMsg(msg, 'The address needs at least 3 letters or numbers (a to z, 0 to 9 and dashes).', true);
        if (source.value.trim().length < 2) return showMsg(msg, 'Say who made the stickers.', true);
        if (!rights.box.checked) return showMsg(msg, 'Tick the box to confirm you have the rights to these stickers.', true);
        submit.disabled = true; showMsg(msg, 'Uploading the cover...', false);
        uploadFile(f, 'sticker').then(function (mediaId) {
          return api('POST', '/admin/stickers/packs', {
            name: name.value.trim(), slug: slug.value, description: desc.value.trim(), category: category.value, coverMediaId: mediaId,
            premium: premium.box.checked, license: license.value, sourceAttribution: source.value.trim(),
          });
        }).then(function (d) { openPack(d.id); }).catch(function (e) { submit.disabled = false; showMsg(msg, e.message, true); });
      });

      out.appendChild(h('h2', null, 'New pack'));
      out.appendChild(h('div', { class: 'card' }, field('Cover', cover), field('Name', name), field('Address', slug), field('Category', category), field('Description', desc),
        field('Licence', license), field('Source', source), premium.row, rights.row, h('div', { class: 'row' }, submit), msg,
        h('p', { class: 'small muted' }, 'A new pack is a draft. Add stickers on the next page, then publish.')));

      out.appendChild(h('h2', null, 'Packs'));
      out.appendChild(tabs); out.appendChild(holder);
      function show() {
        clear(tabs); clear(holder);
        [['draft', 'Drafts'], ['published', 'Published'], ['unpublished', 'Unpublished'], ['removed', 'Removed']].forEach(function (o) {
          tabs.appendChild(h('button', { class: 'tab' + (status === o[0] ? ' on' : ''), type: 'button', onclick: function () { status = o[0]; show(); } }, o[1]));
        });
        cursorList(holder, '/admin/stickers/packs', { status: status }, function (p) {
          return h('div', { class: 'card' }, h('div', { class: 'row' }, thumb(p.coverThumbUrl, p.name, 56),
            h('div', null, h('b', null, p.name), ' ', pill(p.status), p.premium ? pill('premium') : null, p.featured ? pill('featured') : null,
              h('div', { class: 'small muted' }, p.stickerCount + ' stickers - ' + words(p.category)))),
            h('div', { class: 'row' }, h('button', { class: 'btn ghost', type: 'button', onclick: function () { openPack(p.id); } }, 'Open')));
        }, 'No packs here yet.');
      }
      show();
    }

    function drawPack(id) {
      var box = h('div', null, 'Loading...'); out.appendChild(box);
      function load() { api('GET', '/admin/stickers/packs/' + id).then(draw).catch(function (e) { fail(box, e); }); }
      function patch(fields) { return api('PATCH', '/admin/stickers/packs/' + id, fields).then(load); }
      function draw(d) {
        clear(box);
        var p = d.pack, live = d.stickers.filter(function (s) { return s.status === 'active'; });
        box.appendChild(h('button', { class: 'btn ghost', type: 'button', onclick: showList }, 'Back to packs'));
        box.appendChild(h('h2', null, p.name));
        box.appendChild(h('div', { class: 'row' }, pill(p.status), p.premium ? pill('premium') : null, p.featured ? pill('featured') : null, h('span', { class: 'small muted' }, words(p.category) + ' - ' + words(p.license) + ' - ' + p.sourceAttribution)));
        var acts = h('div', { class: 'row' });
        if (p.status !== 'published' && p.status !== 'removed') acts.appendChild(confirmButton('Publish', 'Publish "' + p.name + '"? Students will see it in the sticker store straight away.', function () { return api('PATCH', '/admin/stickers/packs/' + id + '/status', { status: 'published' }).then(load); }, false));
        if (p.status === 'published') acts.appendChild(confirmButton('Unpublish', 'Unpublish "' + p.name + '"? It leaves the store. People who installed it keep it, and old messages still show its stickers.', function () { return api('PATCH', '/admin/stickers/packs/' + id + '/status', { status: 'unpublished' }).then(load); }, true));
        if (p.status !== 'removed') {
          acts.appendChild(confirmButton(p.featured ? 'Stop featuring' : 'Feature', (p.featured ? 'Stop featuring ' : 'Feature ') + '"' + p.name + '"?', function () { return patch({ featured: !p.featured }); }, false));
          acts.appendChild(confirmButton(p.premium ? 'Make free' : 'Make Premium', (p.premium ? 'Make "' + p.name + '" free for everyone?' : 'Make "' + p.name + '" Premium? People who already installed it keep it only while they have Premium.'), function () { return patch({ premium: !p.premium }); }, false));
          acts.appendChild(confirmButton('Remove pack', 'Remove "' + p.name + '" for good? This cannot be undone.', function () { return api('PATCH', '/admin/stickers/packs/' + id + '/status', { status: 'removed' }).then(load); }, true));
        }
        box.appendChild(acts);

        box.appendChild(h('h2', null, 'Stickers (' + live.length + ')'));
        if (!live.length) box.appendChild(h('p', { class: 'muted' }, 'No stickers yet. Add some below.'));
        live.forEach(function (s, i) {
          function move(by) {
            var ids = live.map(function (x) { return x.id; }), j = i + by;
            if (j < 0 || j >= ids.length) return Promise.resolve();
            var t = ids[i]; ids[i] = ids[j]; ids[j] = t;
            return api('PUT', '/admin/stickers/packs/' + id + '/order', { stickerIds: ids }).then(load);
          }
          var left = h('button', { class: 'btn ghost', type: 'button', 'aria-label': 'Move earlier' }, '<');
          var right = h('button', { class: 'btn ghost', type: 'button', 'aria-label': 'Move later' }, '>');
          left.disabled = i === 0; right.disabled = i === live.length - 1;
          left.addEventListener('click', function () { left.disabled = true; move(-1).catch(function (e) { left.disabled = false; window.alert(e.message); }); });
          right.addEventListener('click', function () { right.disabled = true; move(1).catch(function (e) { right.disabled = false; window.alert(e.message); }); });
          box.appendChild(h('div', { class: 'card' }, h('div', { class: 'row' }, thumb(s.thumbUrl, s.label || 'Sticker', 64),
            h('div', null, h('b', null, (i + 1) + '. ' + (s.label || 'Sticker')), s.animated ? pill('animated') : null, h('div', { class: 'small muted' }, s.width + ' x ' + s.height))),
            h('div', { class: 'row' }, left, right, confirmButton('Remove', 'Remove this sticker? Old messages that used it will show "Sticker unavailable".', function () { return api('DELETE', '/admin/stickers/' + s.id).then(load); }, true))));
        });

        if (p.status !== 'removed') {
          var files = h('input', { type: 'file', accept: 'image/png,image/webp', multiple: 'multiple', 'aria-label': 'Sticker files' });
          var msg = h('div', { role: 'status', class: 'small' }), go = h('button', { class: 'btn', type: 'button' }, 'Add stickers');
          go.addEventListener('click', function () {
            var list = Array.prototype.slice.call(files.files || []);
            if (!list.length) return showMsg(msg, 'Choose one or more sticker files.', true);
            if (live.length + list.length > 60) return showMsg(msg, 'A pack holds at most 60 stickers.', true);
            go.disabled = true;
            var done = 0, failed = [];
            // One after another, so the order of the files is the order in the pack and a bad file never blocks the rest.
            list.reduce(function (chain, f, n) {
              return chain.then(function () {
                showMsg(msg, 'Adding ' + (n + 1) + ' of ' + list.length + ': ' + f.name, false);
                if (['image/png', 'image/webp'].indexOf(f.type) < 0) { failed.push(f.name + ': not a PNG or WebP'); return; }
                return uploadFile(f, 'sticker').then(function (mediaId) {
                  return api('POST', '/admin/stickers/packs/' + id + '/stickers', { mediaId: mediaId, label: labelOf(f.name) });
                }).then(function () { done++; }).catch(function (e) { failed.push(f.name + ': ' + e.message); });
              });
            }, Promise.resolve()).then(function () {
              go.disabled = false; files.value = '';
              if (failed.length) { load(); window.setTimeout(function () { window.alert(done + ' added. These were not added:\n' + failed.join('\n')); }, 50); }
              else load();
            });
          });
          box.appendChild(h('h2', null, 'Add stickers'));
          box.appendChild(h('div', { class: 'card' }, field('Files', files), h('div', { class: 'row' }, go), msg,
            h('p', { class: 'small muted' }, 'PNG or WebP with a transparent background, up to 512 KB each. Animated WebP is fine (at most 60 frames). The file name becomes the sticker name, so "late-for-class.png" is "late for class".')));
        }
      }
      load();
    }

    showList();
  }
`;
