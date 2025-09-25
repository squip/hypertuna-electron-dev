// MembersList.js - Enhanced with deduplication
import { NostrUtils } from "./NostrUtils.js";
import { HypertunaUtils } from "./HypertunaUtils.js";

export default class MembersList {
  constructor(container, client, currentUserPubkey, options = {}) {
    this.container = container;
    this.client = client;
    this.currentUserPubkey = currentUserPubkey;
    this.renderedMembers = new Set(); // Track rendered members to prevent duplicates
    this.onlineStatusResolver = options.onlineStatusResolver || null;
  }

  setUserPubkey(pubkey) {
    this.currentUserPubkey = pubkey;
  }

  setOnlineStatusResolver(resolver) {
    this.onlineStatusResolver = resolver;
  }

  async render(members = [], admins = []) {
    if (!this.container) return;

    // Clear container and reset tracked members
    this.container.innerHTML = '';
    this.renderedMembers.clear();

    // Create a map to ensure unique members
    const uniqueMembers = new Map();
    
    // Add members first
    members.forEach(m => {
        if (m && m.pubkey && !uniqueMembers.has(m.pubkey)) {
            uniqueMembers.set(m.pubkey, { 
                pubkey: m.pubkey, 
                roles: m.roles || ['member'] 
            });
        }
    });
    
    // Update roles for admins
    admins.forEach(a => {
        if (a && a.pubkey) {
            const existing = uniqueMembers.get(a.pubkey);
            if (existing) {
                // Merge roles, ensuring 'admin' is included
                const roles = new Set([...(existing.roles || []), ...(a.roles || ['admin'])]);
                if (!roles.has('admin')) roles.add('admin');
                existing.roles = Array.from(roles);
            } else {
                uniqueMembers.set(a.pubkey, {
                    pubkey: a.pubkey,
                    roles: a.roles || ['admin']
                });
            }
        }
    });
    
    const membersList = Array.from(uniqueMembers.values());
    
    if (membersList.length === 0) {
        this.container.innerHTML = `
            <div class="empty-state">
                <p>No members in this relay yet</p>
            </div>
        `;
        return;
    }

    // Fetch profiles for all members
    const profiles = {};
    const memberPubkeys = membersList.map(m => m.pubkey);
    
    for (const pk of memberPubkeys) {
        try {
            const profile = await this.client.fetchUserProfile(pk);
            profiles[pk] = profile || {};
        } catch {
            profiles[pk] = {};
        }
    }

    const isCurrentUserAdmin = admins.some(a => a.pubkey === this.currentUserPubkey);

    // Render each member (with deduplication check)
    for (const member of membersList) {
        const pk = member.pubkey;
        
        // Skip if already rendered (extra safety check)
        if (this.renderedMembers.has(pk)) {
            console.warn(`Skipping duplicate render for member: ${pk}`);
            continue;
        }
        
        this.renderedMembers.add(pk);

        const profile = profiles[pk];
        const roles = member.roles || ['member'];
        const npub = NostrUtils.hexToNpub(pk);
        const displayPub = NostrUtils.truncateNpub(npub);
        const name = profile.name || "User_" + NostrUtils.truncatePubkey(pk);
        const first = name.charAt(0).toUpperCase();
        const roleText = roles.includes('admin') ? 'Admin' : 'Member';
        const roleClass = roles.includes('admin') ? 'admin' : '';
        const resolvedPicture = profile.picture
            ? HypertunaUtils.resolvePfpUrl(profile.pictureTagUrl || profile.picture, profile.pictureIsHypertunaPfp)
            : null;
        const isOnline = this.onlineStatusResolver ? !!this.onlineStatusResolver(pk) : false;

        const item = document.createElement('div');
        item.className = 'member-item';
        item.dataset.pubkey = pk; // Add data attribute for easy identification
        if (isOnline) {
            item.dataset.online = 'true';
        } else {
            delete item.dataset.online;
        }

        item.innerHTML = `
            <div class="member-avatar">${resolvedPicture ? `<img src="${resolvedPicture}" alt="${name}">` : `<span>${first}</span>`}</div>
            <div class="member-info">
                <div class="member-name">${name}${isOnline ? '<span class="member-status-dot" title="Online"></span>' : ''}</div>
                <div class="member-pubkey">${displayPub}</div>
            </div>
            <span class="member-role ${roleClass}">${roleText}</span>`;

        if (isCurrentUserAdmin && pk !== this.currentUserPubkey) {
            const actions = document.createElement('div');
            actions.className = 'member-actions';

            if (!roles.includes('admin')) {
                const promote = document.createElement('button');
                promote.className = 'btn btn-secondary btn-small';
                promote.dataset.action = 'promote';
                promote.dataset.pubkey = pk;
                promote.textContent = 'Make Admin';
                promote.addEventListener("click", (e) => {
                    e.stopPropagation();
                    this.container.dispatchEvent(new CustomEvent("promote", { 
                        detail: { pubkey: pk },
                        bubbles: true
                    }));
                });
                actions.appendChild(promote);
            }

            const remove = document.createElement('button');
            remove.className = 'btn btn-danger btn-small';
            remove.dataset.action = 'remove';
            remove.dataset.pubkey = pk;
            remove.textContent = 'Remove';
            remove.addEventListener("click", (e) => {
                e.stopPropagation();
                this.container.dispatchEvent(new CustomEvent("remove", { 
                    detail: { pubkey: pk },
                    bubbles: true
                }));
            });
            actions.appendChild(remove);

            item.appendChild(actions);
        }

        this.container.appendChild(item);
    }
  }

  updateOnlineStatuses(resolver = null) {
    if (resolver) {
      this.onlineStatusResolver = resolver;
    }
    if (!this.container || !this.onlineStatusResolver) return;

    const items = this.container.querySelectorAll('.member-item');
    items.forEach((item) => {
      const pk = item.dataset.pubkey;
      if (!pk) return;
      const isOnline = !!this.onlineStatusResolver(pk);
      const nameEl = item.querySelector('.member-name');
      if (!nameEl) return;
      let indicator = nameEl.querySelector('.member-status-dot');

      if (isOnline) {
        item.dataset.online = 'true';
        if (!indicator) {
          indicator = document.createElement('span');
          indicator.className = 'member-status-dot';
          indicator.title = 'Online';
          nameEl.appendChild(indicator);
        }
      } else {
        delete item.dataset.online;
        if (indicator) {
          indicator.remove();
        }
      }
    });
  }
  
  // New method to check if a member is already rendered
  isMemberRendered(pubkey) {
    return this.renderedMembers.has(pubkey);
  }
  
  // New method to clear the rendered members set
  clearRenderedMembers() {
    this.renderedMembers.clear();
  }
}
