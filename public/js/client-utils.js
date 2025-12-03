(function (global) {
    'use strict';

    const normalizeString = (str = '') => {
        return String(str)
            .toLowerCase()
            .replace(/[^\w\s]|_/g, '')
            .replace(/\s+/g, ' ')
            .trim();
    };

    const cardFilter = (text, input) => {
        const label = typeof text === 'object' && text !== null && 'label' in text
            ? text.label
            : text;
        return normalizeString(label).includes(normalizeString(input));
    };

    const escapeHTML = (value = '') => {
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    };

    const generateId = () => {
        if (global.crypto && typeof global.crypto.randomUUID === 'function') {
            return global.crypto.randomUUID();
        }
        const bytes = new Uint8Array(16);
        if (global.crypto && typeof global.crypto.getRandomValues === 'function') {
            global.crypto.getRandomValues(bytes);
        } else {
            for (let i = 0; i < bytes.length; i += 1) {
                bytes[i] = Math.floor(Math.random() * 256);
            }
        }
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        const byteToHex = [];
        for (let i = 0; i < 256; i += 1) {
            byteToHex.push((i + 0x100).toString(16).substring(1));
        }
        return (
            byteToHex[bytes[0]] + byteToHex[bytes[1]] + byteToHex[bytes[2]] + byteToHex[bytes[3]] + '-' +
            byteToHex[bytes[4]] + byteToHex[bytes[5]] + '-' +
            byteToHex[bytes[6]] + byteToHex[bytes[7]] + '-' +
            byteToHex[bytes[8]] + byteToHex[bytes[9]] + '-' +
            byteToHex[bytes[10]] + byteToHex[bytes[11]] + byteToHex[bytes[12]] + byteToHex[bytes[13]] + byteToHex[bytes[14]] + byteToHex[bytes[15]]
        );
    };

    const defaultCardSearchFetcher = async (query, options = {}) => {
        const limit = options.limit ?? 8;
        const response = await fetch(`/api/cards/search?q=${encodeURIComponent(query)}&limit=${limit}`, {
            signal: options.signal,
        });
        if (!response.ok) {
            const error = new Error('Card search request failed.');
            error.status = response.status;
            throw error;
        }
        return response.json();
    };

    const positionDropdown = (input, dropdown) => {
        const rect = input.getBoundingClientRect();
        dropdown.style.width = `${rect.width}px`;
        dropdown.style.left = `${Math.round(rect.left + global.scrollX)}px`;
        dropdown.style.top = `${Math.round(rect.bottom + global.scrollY)}px`;
    };

    class CardSearchWidget {
        constructor(options) {
            if (!options || !options.input) {
                throw new Error('CardSearchWidget requires an input element.');
            }

            this.input = options.input;
            this.onSelect = typeof options.onSelect === 'function' ? options.onSelect : null;
            this.minLength = Number.isFinite(options.minLength) ? options.minLength : 2;
            this.limit = Number.isFinite(options.limit) ? options.limit : 8;
            this.debounceMs = Number.isFinite(options.debounceMs) ? options.debounceMs : 200;
            this.fetchCards = typeof options.fetchCards === 'function' ? options.fetchCards : defaultCardSearchFetcher;
            this.showSetInfo = options.showSetInfo === true;
            this.enablePreview = options.enablePreview === true;
            this.results = [];
            this.activeIndex = -1;
            this.abortController = null;
            this.debounceTimer = null;
            this.previewEl = null;
            this.previewImg = null;

            this.dropdown = document.createElement('div');
            this.dropdown.className = 'card-search-dropdown hidden';
            this.statusEl = document.createElement('div');
            this.statusEl.className = 'card-search__status';
            this.listEl = document.createElement('ul');
            this.listEl.className = 'card-search__list';
            this.dropdown.appendChild(this.statusEl);
            this.dropdown.appendChild(this.listEl);

            document.body.appendChild(this.dropdown);
            if (this.enablePreview) {
                this.previewEl = document.createElement('div');
                this.previewEl.className = 'card-search__preview hidden';
                this.previewImg = document.createElement('img');
                this.previewImg.alt = '';
                this.previewEl.appendChild(this.previewImg);
                document.body.appendChild(this.previewEl);
            }

            this.handleInput = this.handleInput.bind(this);
            this.handleFocus = this.handleFocus.bind(this);
            this.handleKeyDown = this.handleKeyDown.bind(this);
            this.handleDocumentClick = this.handleDocumentClick.bind(this);

            this.input.addEventListener('input', this.handleInput);
            this.input.addEventListener('focus', this.handleFocus);
            this.input.addEventListener('keydown', this.handleKeyDown);
            document.addEventListener('pointerdown', this.handleDocumentClick);
            global.addEventListener('resize', () => {
                if (!this.dropdown.classList.contains('hidden')) {
                    positionDropdown(this.input, this.dropdown);
                }
            });
            global.addEventListener('scroll', () => {
                if (!this.dropdown.classList.contains('hidden')) {
                    positionDropdown(this.input, this.dropdown);
                }
            }, true);
        }

        destroy() {
            this.input.removeEventListener('input', this.handleInput);
            this.input.removeEventListener('focus', this.handleFocus);
            this.input.removeEventListener('keydown', this.handleKeyDown);
            document.removeEventListener('pointerdown', this.handleDocumentClick);
            if (this.abortController) {
                this.abortController.abort();
            }
            this.dropdown.remove();
            if (this.previewEl) {
                this.previewEl.remove();
                this.previewEl = null;
                this.previewImg = null;
            }
        }

        handleInput() {
            const query = this.input.value.trim();
            if (query.length < this.minLength) {
                this.hideDropdown();
                return;
            }
            this.debounce(() => this.search(query));
        }

        handleFocus() {
            const query = this.input.value.trim();
            if (query.length >= this.minLength) {
                positionDropdown(this.input, this.dropdown);
                this.dropdown.classList.remove('hidden');
            }
        }

        handleKeyDown(event) {
            if (this.dropdown.classList.contains('hidden')) {
                return;
            }

            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                if (this.results.length === 0) {
                    return;
                }
                const direction = event.key === 'ArrowDown' ? 1 : -1;
                this.activeIndex = (this.activeIndex + direction + this.results.length) % this.results.length;
                this.updateActiveItem();
            } else if (event.key === 'Enter') {
                if (this.activeIndex >= 0 && this.results[this.activeIndex]) {
                    event.preventDefault();
                    this.selectResult(this.results[this.activeIndex]);
                }
            } else if (event.key === 'Escape') {
                this.hideDropdown();
            }
        }

        handleDocumentClick(event) {
            if (event.target === this.input) return;
            if (this.dropdown.contains(event.target)) return;
            this.hideDropdown();
        }

        debounce(callback) {
            if (this.debounceTimer) {
                clearTimeout(this.debounceTimer);
            }
            this.debounceTimer = setTimeout(callback, this.debounceMs);
        }

        async search(query) {
            this.showStatus('Loading…');
            positionDropdown(this.input, this.dropdown);
            this.dropdown.classList.remove('hidden');

            if (this.abortController) {
                this.abortController.abort();
            }
            this.abortController = new AbortController();
            const { signal } = this.abortController;

            try {
                const results = await this.fetchCards(query, { limit: this.limit, signal });
                if (signal.aborted) {
                    return;
                }
                this.results = Array.isArray(results) ? results : [];
                if (this.results.length === 0) {
                    this.showStatus('No matching cards found.');
                    return;
                }
                this.renderResults();
            } catch (error) {
                if (signal.aborted) return;
                console.error('Card search failed:', error);
                this.showStatus('Unable to load cards right now.');
            }
        }

        showStatus(message) {
            this.listEl.innerHTML = '';
            this.statusEl.textContent = message;
        }

        showPreview(card, anchorEl) {
            if (!this.enablePreview || !this.previewEl || !this.previewImg) return;
            const src = card.image_normal || card.image_small;
            if (!src) {
                this.hidePreview();
                return;
            }
            const rect = anchorEl?.getBoundingClientRect();
            if (rect) {
                this.previewEl.style.top = `${Math.max(8, rect.top + global.scrollY)}px`;
                this.previewEl.style.left = `${rect.right + 12 + global.scrollX}px`;
            }
            this.previewImg.src = src;
            this.previewImg.alt = card.name || 'Card preview';
            this.previewEl.classList.remove('hidden');
        }

        hidePreview() {
            if (!this.previewEl) return;
            this.previewEl.classList.add('hidden');
        }

        renderResults() {
            this.statusEl.textContent = '';
            this.listEl.innerHTML = '';
            this.activeIndex = this.results.length > 0 ? 0 : -1;
            if (this.enablePreview) {
                this.hidePreview();
            }

            this.results.forEach((card, index) => {
                const item = document.createElement('button');
                item.type = 'button';
                item.className = 'card-search__item';
                item.dataset.index = String(index);

                const thumbSrc = card.image_small || card.image_normal;
                if (thumbSrc) {
                    const img = document.createElement('img');
                    img.src = thumbSrc;
                    img.alt = card.name;
                    img.className = 'card-search__thumb';
                    item.appendChild(img);
                } else {
                    const placeholder = document.createElement('div');
                    placeholder.className = 'card-search__thumb';
                    placeholder.style.display = 'flex';
                    placeholder.style.alignItems = 'center';
                    placeholder.style.justifyContent = 'center';
                    placeholder.style.background = 'rgba(90, 90, 110, 0.35)';
                    placeholder.textContent = '?';
                    item.appendChild(placeholder);
                }

                const meta = document.createElement('div');
                meta.className = 'card-search__meta';

                const nameEl = document.createElement('span');
                nameEl.className = 'card-search__name';
                nameEl.textContent = card.name;
                meta.appendChild(nameEl);

                if (this.showSetInfo) {
                    const hasSetInfo = card.set_name || card.collector_number;
                    if (hasSetInfo) {
                        const setEl = document.createElement('span');
                        setEl.className = 'card-search__set';
                        const setText = [];
                        if (card.set_name) setText.push(card.set_name);
                        if (card.collector_number) setText.push(`#${card.collector_number}`);
                        setEl.textContent = setText.join(' \u2022 ');
                        meta.appendChild(setEl);
                    }
                }

                item.appendChild(meta);

                item.addEventListener('click', (event) => {
                    event.preventDefault();
                    this.selectResult(card);
                });
                if (this.enablePreview) {
                    item.addEventListener('mouseenter', () => this.showPreview(card, item));
                    item.addEventListener('mouseleave', () => this.hidePreview());
                }

                this.listEl.appendChild(item);
            });

            this.dropdown.scrollTop = 0;

            if (this.activeIndex >= 0) {
                this.updateActiveItem();
            }
        }

        updateActiveItem() {
            const items = this.listEl.querySelectorAll('.card-search__item');
            items.forEach(item => item.classList.remove('card-search__item--active'));
            if (this.activeIndex >= 0 && items[this.activeIndex]) {
                items[this.activeIndex].classList.add('card-search__item--active');
                const itemRect = items[this.activeIndex].getBoundingClientRect();
                const dropdownRect = this.dropdown.getBoundingClientRect();
                if (itemRect.top < dropdownRect.top) {
                    this.dropdown.scrollTop -= (dropdownRect.top - itemRect.top);
                } else if (itemRect.bottom > dropdownRect.bottom) {
                    this.dropdown.scrollTop += (itemRect.bottom - dropdownRect.bottom);
                }
            }
        }

        selectResult(card) {
            this.input.value = card.name;
            this.hideDropdown();
            if (this.onSelect) {
                this.onSelect(card);
            }
        }

        hideDropdown() {
            this.results = [];
            this.activeIndex = -1;
            this.dropdown.classList.add('hidden');
            this.listEl.innerHTML = '';
            this.statusEl.textContent = '';
            if (this.enablePreview) {
                this.hidePreview();
            }
        }
    }

    const cardUtils = {
        normalizeString,
        cardFilter,
        escapeHTML,
        generateId,
        CardSearchWidget,
        createCardSearchWidget: (options) => new CardSearchWidget(options),
        searchCards: defaultCardSearchFetcher,
    };

    global.cardUtils = Object.freeze(cardUtils);
})(window);
