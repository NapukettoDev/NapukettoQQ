import type { Group } from "../../types/index.js";
import { GroupListUpdateType } from "../../types/index.js";

export class GroupMembership {
    private joined: Set<string> | null = null;
    private readonly left = new Set<string>();

    allows(groupCode: string): boolean {
        return this.joined?.has(groupCode) ?? !this.left.has(groupCode);
    }

    replace(groups: readonly Group[]): void {
        this.joined = new Set(groups.map((group) => group.groupCode));
        this.left.clear();
    }

    update(type: GroupListUpdateType, groups: readonly Group[]): void {
        if (type === GroupListUpdateType.ALL) {
            this.replace(groups);
            return;
        }
        for (const { groupCode } of groups) {
            this.left.delete(groupCode);
            this.joined?.add(groupCode);
        }
    }

    leave(groupCode: string): void {
        if (this.joined === null) {
            this.left.add(groupCode);
        } else {
            this.joined.delete(groupCode);
        }
    }

    clear(): void {
        this.joined = null;
        this.left.clear();
    }
}
