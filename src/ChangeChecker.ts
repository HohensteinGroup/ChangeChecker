import { ObjectDiff, IArrayDiff, IChangedProperty, IUnchangedProperty, ValueLike, ValueType, Era, PropertyDiff, State } from "./DiffTypes";

export const objectIdSymbol: unique symbol = Symbol.for("objectId");

export class ChangeChecker {
    private currentObjectId: number = 0;
    private referenceLikePlugins: Array<IReferenceLikePlugin<any>> = [];
    private valueLikePlugins: Array<IValueLikePlugin<any>> = [];

    // to avoid deoptimizations we reuse the globalLookup
    private globalLookup: Map<any, IObjectLookupEntry> = new Map();

    public addPlugin<T>(plugin: IReferenceLikePlugin<T> | IValueLikePlugin<T>): ChangeChecker {
        if (this.referenceLikePlugins.some((x) => x.name === plugin.name) || this.valueLikePlugins.some((x) => x.name === plugin.name)) {
            throw new Error(`Plugin with name ${plugin.name} is already registered.`);
        }

        if (plugin.isValueLikePlugin) {
            this.valueLikePlugins.push(plugin);
        }
        else {
            this.referenceLikePlugins.push(plugin);
        }

        return this;
    }

    public removePlugin(name: string): ChangeChecker {
        let index = this.referenceLikePlugins.findIndex((x) => x.name === name);
        if (index !== -1) {
            this.referenceLikePlugins.splice(index, 1);
            return this;
        }

        index = this.valueLikePlugins.findIndex((x) => x.name === name);
        if (index !== -1) {
            this.valueLikePlugins.splice(index, 1);
            return this;
        }

        throw new Error(`Plugin with name ${name} not found.`);
    }

    public takeSnapshot<T extends object>(model: T): T {
        if (!(model instanceof Object)) {
            throw new Error("The model must be an object.");
        }

        this.assignObjectIds(model, new Set());
        return this.clone(model, new Map()) as T;
    }

    public createDiff<T>(snapshot: T[], currentModel: T[]): IArrayDiff<T>;
    public createDiff<T extends object>(snapshot: T, currentModel: T): ObjectDiff<T>;
    public createDiff<T>(snapshot: T, currentModel: T): IArrayDiff<T> | ObjectDiff<T> {
        if (!this.isReference(snapshot) || !this.isReference(currentModel) || snapshot[objectIdSymbol] !== currentModel[objectIdSymbol]) {
            throw new Error("Parameter 'snapshot' and parameter 'currentModel' have to share the same root ('objectId' differs or may not present).");
        }

        return this.createDiffInternal(snapshot, currentModel);
    }

    private isDirtyArrow = (diff: any) => this.isDirtyInternal(diff, new Set());
    private unwrapArrow = (era: Era, diff: any) => era === Era.Present ? this.unwrapPresentInternal(diff, new Map()) : this.unwrapFormerInternal(diff, new Map());

    private createDiffInternal(formerObject: any, presentObject: any): any {
        const globalLookup = this.buildLookupTree(formerObject, presentObject);

        for (const entry of globalLookup.values()) {
            if (Array.isArray(entry.formerObject || entry.presentObject)) {
                this.bindArrayDiff(entry, globalLookup);
            }
            else {
                this.bindObjectDiff(entry, globalLookup);
            }
        }

        const result = globalLookup.get(formerObject[objectIdSymbol])!.diff;

        this.globalLookup.clear();

        return result;
    }

    private bindObjectDiff(lookupEntry: IObjectLookupEntry, globalLookup: Map<any, IObjectLookupEntry>): void {
        lookupEntry.diff[$isCreatedSymbol] = lookupEntry.formerObject === null;
        lookupEntry.diff[$isDeletedSymbol] = lookupEntry.presentObject === null;

        if (lookupEntry.formerObject) {
            lookupEntry.diff[objectIdSymbol] = lookupEntry.formerObject[objectIdSymbol];
        }

        for (const propertyKey of lookupEntry.propertyKeys) {
            const formerValueOrReference = lookupEntry.formerObject ? lookupEntry.formerObject[propertyKey] : undefined;
            const presentValueOrReference = lookupEntry.presentObject ? lookupEntry.presentObject[propertyKey] : undefined;
            if (typeof formerValueOrReference === "function" || typeof presentValueOrReference === "function") {
                continue;
            }

            const propertyDiff: PropertyDiffImpl = this.createPropertyDiff(lookupEntry, globalLookup, formerValueOrReference, presentValueOrReference);

            lookupEntry.diff[propertyKey] = propertyDiff;
        }
    }

    private createPropertyDiff(lookupEntry: IObjectLookupEntry, globalLookup: Map<any, IObjectLookupEntry>, formerValueOrReference: any, presentValueOrReference: any): PropertyDiffImpl {
        let propertyDiff: PropertyDiffImpl;
        if (lookupEntry.presentObject === null) {
            const $formerValue = this.resolveValueOrDiff(formerValueOrReference, globalLookup);
            propertyDiff = new PropertyDiffImpl(false, this.isDirtyArrow, this.unwrapArrow, $formerValue);
        }
        else if (lookupEntry.formerObject === null) {
            const $value = this.resolveValueOrDiff(presentValueOrReference, globalLookup);
            propertyDiff = new PropertyDiffImpl(false, this.isDirtyArrow, this.unwrapArrow, $value);
        }
        else {
            const $value = this.resolveValueOrDiff(presentValueOrReference, globalLookup);
            const $formerValue = this.resolveValueOrDiff(formerValueOrReference, globalLookup);
            const isSameValue = $formerValue === $value;
            const isSameReference = !isSameValue && this.isReference($formerValue) && this.isReference($value) && $formerValue[objectIdSymbol] === $value[objectIdSymbol];
            const isSameValueLike = !isSameValue && !isSameReference && this.isSameValueLike($formerValue, $value);
            if (isSameValue || isSameReference || isSameValueLike) {
                propertyDiff = new PropertyDiffImpl(false, this.isDirtyArrow, this.unwrapArrow, $value);
            }
            else {
                propertyDiff = new PropertyDiffImpl(true, this.isDirtyArrow, this.unwrapArrow, $value, $formerValue);
                lookupEntry.diff[$isChangedSymbol] = true;
            }
        }
        return propertyDiff;
    }

    private bindArrayDiff(lookupEntry: IObjectLookupEntry, globalLookup: Map<any, IObjectLookupEntry>): void {
        // This method is optimized for speed. This is why we prefer arrays over objects.

        lookupEntry.diff.$isCreated = lookupEntry.formerObject === null;
        lookupEntry.diff.$isDeleted = lookupEntry.presentObject === null;

        if (lookupEntry.formerObject) {
            lookupEntry.diff[objectIdSymbol] = lookupEntry.formerObject[objectIdSymbol];
        }

        if (lookupEntry.presentObject === null) {
            for (const item of lookupEntry.formerObject) {
                lookupEntry.diff.$other.push(this.resolveValueOrDiff(item, globalLookup));
            }
        }

        if (lookupEntry.formerObject === null) {
            for (const item of lookupEntry.presentObject) {
                if (typeof item === "function") {
                    continue;
                }
                lookupEntry.diff.$other.push(this.resolveValueOrDiff(item, globalLookup));
            }
        }

        if (lookupEntry.formerObject && lookupEntry.presentObject) {
            // this map holds all possible results as key. The inner arrays 1st index holds the occurrences of the former array and the 2nd index holds the occurrences of the present array.
            const resultMap: Map<any, [any[], any[]]> = new Map();
            for (const item of lookupEntry.presentObject) {
                if (typeof item === "function") {
                    continue;
                }

                const arrayDiffEntry = this.resolveValueOrDiff(item, globalLookup);
                const entry = resultMap.get(arrayDiffEntry);
                if (entry) {
                    entry[1].push(arrayDiffEntry);
                }
                else {
                    resultMap.set(arrayDiffEntry, [[], [arrayDiffEntry]]);
                }
            }

            for (const item of lookupEntry.formerObject) {
                const arrayDiffEntry = this.resolveValueOrDiff(item, globalLookup);
                const entry = resultMap.get(arrayDiffEntry);
                if (entry) {
                    entry[0].push(arrayDiffEntry);
                }
                else {
                    resultMap.set(arrayDiffEntry, [[arrayDiffEntry], []]);
                }
            }

            const valueLikes: Array<[any, [any[], any[]]]> = [];
            for (const entry of resultMap) {
                if (this.isValueLike(entry[0])) {
                    // because maps and sets can not recognize "value likes" equality (new Date(1993, 3) != new Date(1993, 3) == true) we have to skip them for now.
                    valueLikes.push(entry);
                    continue;
                }

                const formerOccurrences = entry[1][0];
                const presentOccurrences = entry[1][1];

                const deleted = formerOccurrences.splice(0, formerOccurrences.length - presentOccurrences.length);
                const inserted = presentOccurrences.splice(0, presentOccurrences.length - formerOccurrences.length);
                const other = inserted.length > 0 ? presentOccurrences : formerOccurrences;

                // tslint:disable:curly
                for (let i = 0; i < deleted.length; lookupEntry.diff.$deleted.push(deleted[i++])) continue;
                for (let i = 0; i < inserted.length; lookupEntry.diff.$inserted.push(inserted[i++])) continue;
                for (let i = 0; i < other.length; lookupEntry.diff.$other.push(other[i++])) continue;
                // tslint:enable:curly
            }

            // now we sum the number of occurrences of all "value likes".
            for (let outerIndex = 0; outerIndex < valueLikes.length; outerIndex++) {

                // find the plugin
                const plugin = this.valueLikePlugins.find((x) => x.isMatch(valueLikes[outerIndex][0]))!;

                for (let innerIndex = outerIndex + 1; innerIndex < valueLikes.length;) {
                    // find all matching value likes
                    if (plugin.isMatch(valueLikes[innerIndex][0]) && plugin.equals(valueLikes[outerIndex][0], valueLikes[innerIndex][0])) {

                        // push all matching to the smallest index
                        // tslint:disable:curly
                        for (let i = 0; i < valueLikes[innerIndex][1][0].length; valueLikes[outerIndex][1][0].push(valueLikes[innerIndex][1][0][i++])) continue;
                        for (let i = 0; i < valueLikes[innerIndex][1][1].length; valueLikes[outerIndex][1][1].push(valueLikes[innerIndex][1][1][i++])) continue;
                        // tslint:enable:curly

                        // delete the entry
                        valueLikes.splice(innerIndex, 1);
                    } else {
                        innerIndex++;
                    }
                }
            }

            // as before we know all past and present number of occurrences.
            for (const item of valueLikes) {
                const formerOccurrences = item[1][0];
                const presentOccurrences = item[1][1];

                const deleted = formerOccurrences.splice(0, formerOccurrences.length - presentOccurrences.length);
                const inserted = presentOccurrences.splice(0, presentOccurrences.length - formerOccurrences.length);
                const other = inserted.length > 0 ? presentOccurrences : formerOccurrences;

                // tslint:disable:curly
                for (let i = 0; i < deleted.length; lookupEntry.diff.$deleted.push(deleted[i++])) continue;
                for (let i = 0; i < inserted.length; lookupEntry.diff.$inserted.push(inserted[i++])) continue;
                for (let i = 0; i < other.length; lookupEntry.diff.$other.push(other[i++])) continue;
                // tslint:enable:curly
            }
        }

        lookupEntry.diff.$isChanged = lookupEntry.diff.$inserted.length > 0 || lookupEntry.diff.$deleted.length > 0;
    }

    private buildLookupTree(formerObject: any, presentObject: any): Map<any, IObjectLookupEntry> {
        // this functions builds up a tree like structure.
        // the globalLookup contains all objects (key = objectId | or the object itself if it doesnt have an objectId).
        // interface IObjectLookupEntry {
        //     formerObject: any; => the object of the snapshot
        //     presentObject: any; => the object of the current model
        //     propertyKeys: Set<string>; => all propertyKeys of the two objects
        //     diff: any; => the ObjectDiff or ArrayDiff
        // }
        this.buildFormerLookupTree(formerObject, this.globalLookup);
        this.buildPresentLookupTree(presentObject, this.globalLookup);
        return this.globalLookup;
    }

    private buildFormerLookupTree(former: any, globalLookup: Map<any, IObjectLookupEntry>): void {
        if (Array.isArray(former)) {
            this.buildFormerArrayLookupTree(former, globalLookup);
            return;
        }

        if (this.isObject(former)) {
            if (this.isValueLike(former)) {
                return;
            }

            this.buildFormerObjectLookupTree(former, globalLookup);
        }
    }

    private buildFormerArrayLookupTree(formerArray: any[], globalLookup: Map<any, IObjectLookupEntry>): void {
        const lookupKey = (formerArray as any)[objectIdSymbol];

        let lookupEntry: IObjectLookupEntry | undefined = globalLookup.get(lookupKey);
        if (lookupEntry === undefined) {
            lookupEntry = {
                formerObject: formerArray,
                presentObject: null,
                propertyKeys: new Set(),
                diff: new ArrayDiffImpl(this.isDirtyArrow, this.unwrapArrow)
            };

            globalLookup.set(lookupKey, lookupEntry);
        }
        else {
            if (lookupEntry.formerObject) {
                // if the object is already set, it must have already been processed and we can stop here (circular reference protection)
                return;
            }

            lookupEntry.formerObject = formerArray;
        }

        for (const item of formerArray) {
            this.buildFormerLookupTree(item, globalLookup);
        }
    }

    private buildFormerObjectLookupTree(formerObject: any, globalLookup: Map<any, IObjectLookupEntry>): void {
        const lookupKey = (formerObject as any)[objectIdSymbol];

        let lookupEntry: IObjectLookupEntry | undefined = globalLookup.get(lookupKey);
        if (lookupEntry === undefined) {
            const propertyKeys = this.getPropertyKeys(formerObject);

            lookupEntry = {
                formerObject,
                presentObject: null,
                propertyKeys,
                diff: new ObjectDiffImpl(this.isDirtyArrow, this.unwrapArrow)
            };

            globalLookup.set(lookupKey, lookupEntry);

            for (const propertyKey of propertyKeys) {
                const property = formerObject[propertyKey];
                this.buildFormerLookupTree(property, globalLookup);
            }
        }
        else {
            if (lookupEntry.formerObject) {
                return;
            }
            lookupEntry.formerObject = formerObject;

            for (const propertyKey of this.getPropertyKeys(formerObject)) {
                lookupEntry.propertyKeys.add(propertyKey);
                const property = formerObject[propertyKey];
                this.buildFormerLookupTree(property, globalLookup);
            }
        }
    }

    private buildPresentLookupTree(present: any, globalLookup: Map<any, IObjectLookupEntry>): void {
        if (Array.isArray(present)) {
            this.buildPresentArrayLookupTree(present, globalLookup);
            return;
        }

        if (this.isObject(present)) {
            if (this.isValueLike(present)) {
                return;
            }

            this.buildPresentObjectLookupTree(present, globalLookup);
        }
    }

    private buildPresentArrayLookupTree(presentArray: any[], globalLookup: Map<any, IObjectLookupEntry>): void {
        // not all arrays of the present model must have an objectId (newly created objects) so we can use the object itself as fallback key for the lookup
        const lookupKey = (presentArray as any)[objectIdSymbol] || presentArray;

        let lookupEntry: IObjectLookupEntry | undefined = globalLookup.get(lookupKey);
        if (lookupEntry === undefined) {
            lookupEntry = {
                formerObject: null,
                presentObject: presentArray,
                propertyKeys: new Set(),
                diff: new ArrayDiffImpl(this.isDirtyArrow, this.unwrapArrow)
            };

            globalLookup.set(lookupKey, lookupEntry);
        }
        else {
            if (lookupEntry.presentObject) {
                if (lookupEntry.presentObject !== presentArray) {
                    throw new Error(`The present model contains two different objects with the same objectId (${lookupKey}). Did you mix partial snapshots containing the same object at different places?`);
                }
                // if the object is already set, it must have already been processed and we can stop here (circular reference protection)
                return;
            }

            lookupEntry.presentObject = presentArray;
        }

        for (const item of presentArray) {
            this.buildPresentLookupTree(item, globalLookup);
        }
    }

    private buildPresentObjectLookupTree(presentObject: any, globalLookup: Map<any, IObjectLookupEntry>): void {
        // not all objects of the present model must have an objectId (newly created objects) so we can use the object itself as fallback key for the lookup
        const lookupKey = (presentObject as any)[objectIdSymbol] || presentObject;

        let lookupEntry: IObjectLookupEntry | undefined = globalLookup.get(lookupKey);
        if (lookupEntry === undefined) {
            const propertyKeys = this.getPropertyKeys(presentObject);

            lookupEntry = {
                formerObject: null,
                presentObject,
                propertyKeys,
                diff: new ObjectDiffImpl(this.isDirtyArrow, this.unwrapArrow)
            };

            globalLookup.set(lookupKey, lookupEntry);

            for (const propertyKey of propertyKeys) {
                const property = presentObject[propertyKey];
                this.buildPresentLookupTree(property, globalLookup);
            }
        }
        else {
            if (lookupEntry.presentObject) {
                if (lookupEntry.presentObject !== presentObject) {
                    throw new Error(`The present model contains two different objects with the same objectId (${lookupKey}). Did you mix partial snapshots containing the same object at different places?`);
                }
                // if the object is already set, it must have already been processed and we can stop here (circular reference protection)
                return;
            }
            lookupEntry.presentObject = presentObject;

            for (const propertyKey of this.getPropertyKeys(presentObject)) {
                // we have to add all propertyKeys again because the present object may have other propertyKeys as the former object
                lookupEntry.propertyKeys.add(propertyKey);
                const property = presentObject[propertyKey];
                this.buildPresentLookupTree(property, globalLookup);
            }
        }
    }

    private clone(any: any, referenceMap: Map<any, any>): any {
        const circularDependency = referenceMap.get(any);
        if (circularDependency) {
            return circularDependency;
        }

        if (any == undefined || this.isValueType(any)) {
            return any;
        }

        if (typeof any === "function") {
            return;
        }

        for (const plugin of this.valueLikePlugins) {
            if (plugin.isMatch(any)) {
                return plugin.clone({ clone: (x) => this.clone(x, referenceMap) }, any);
            }
        }

        for (const plugin of this.referenceLikePlugins) {
            if (plugin.clone && plugin.isMatch(any)) {
                const clone = plugin.clone({ clone: (x) => this.clone(x, referenceMap) }, any);
                clone[objectIdSymbol] = any[objectIdSymbol];
                return clone;
            }
        }

        let result: any;
        if (Array.isArray(any)) {
            result = this.cloneArray(any, referenceMap);
        }
        else {
            result = this.cloneObject(any, referenceMap);
        }

        result[objectIdSymbol] = any[objectIdSymbol];
        return result;
    }

    private cloneArray(source: any[], referenceMap: Map<any, any>): any[] {
        const clone: any[] = [];
        referenceMap.set(source, clone);

        for (const item of source) {
            if (typeof item === "function") {
                continue;
            }

            if (this.isObject(item)) {
                clone.push(this.clone(item, referenceMap));
            }
            else {
                clone.push(item);
            }
        }

        return clone;
    }

    private cloneObject(source: any, referenceMap: Map<any, any>): any {
        const clone = {} as any;
        referenceMap.set(source, clone);

        for (const propertyKey of this.getPropertyKeys(source)) {
            const property = source[propertyKey];

            if (typeof property === "function") {
                continue;
            }

            let value: any;
            if (this.isObject(property)) {
                value = this.clone(property, referenceMap);
            }
            else {
                value = property;
            }

            clone[propertyKey] = value;
        }
        return clone;
    }

    private assignObjectIds(obj: any, referenceSet: Set<any>): void {
        if (referenceSet.has(obj)) {
            return;
        }
        referenceSet.add(obj);

        if (obj[objectIdSymbol] == undefined) {
            obj[objectIdSymbol] = this.getNextObjectId().toString();
        }

        if (Array.isArray(obj)) {
            for (const item of obj) {
                if (typeof item === "function") {
                    continue;
                }

                if (this.isObject(item)) {
                    if (this.isValueLike(item)) {
                        continue;
                    }

                    this.assignObjectIds(item, referenceSet);
                }
            }
        }
        else {
            for (const propertyKey of this.getPropertyKeys(obj)) {
                const value = obj[propertyKey];
                if (typeof value === "function") {
                    continue;
                }

                if (this.isObject(value)) {
                    if (this.isValueLike(value)) {
                        continue;
                    }

                    this.assignObjectIds(value, referenceSet);
                }
            }
        }
    }

    private getNextObjectId(): number {
        return this.currentObjectId++;
    }

    private isSameValueLike(left: any, right: any): boolean {
        for (const plugin of this.valueLikePlugins) {
            if (plugin.isMatch(left)) {
                if (!(plugin.isMatch(right))) {
                    return false;
                }

                return plugin.equals(left, right);
            }
        }

        return false;
    }

    private resolveValueOrDiff(valueOrReference: any, lookup: Map<string, IObjectLookupEntry>): any {
        if (typeof valueOrReference === "object") {
            if (valueOrReference === null) {
                return valueOrReference;
            }

            const objectId = valueOrReference[objectIdSymbol];
            if (objectId !== undefined) {
                return lookup.get(objectId)!.diff;
            }

            const entry = lookup.get(valueOrReference);
            if (entry !== undefined) {
                // in this case we used the present object as lookup key (see: buildPresentObjectLookupTree)
                return entry.diff;
            }

            const plugin = this.valueLikePlugins.find((x) => x.isMatch(valueOrReference));
            if (plugin) {
                // because some "value likes" (like Date) can be changed by methods (e.g. setDate) we need to copy here
                return plugin.clone!({ clone: <T>(x: T) => this.clone(x, new Map()) }, valueOrReference);
            }
        }

        return valueOrReference;
    }

    private getPropertyKeys(obj: any): Set<string> {
        const result: Set<string> = new Set();

        for (let prototype = obj; prototype && prototype !== Object.prototype; prototype = Object.getPrototypeOf(prototype)) {
            for (const name of Object.getOwnPropertyNames(prototype)) {

                // ignore constructor, system-defined and set only properties
                if ((name[0] === "_" && name[1] === "_") || name === "constructor") {
                    continue;
                }

                result.add(name);
            }
        }

        return result;
    }

    private unwrapFormerInternal(diff: any, referenceMap: Map<any, any>): any {
        if (referenceMap.has(diff)) {
            return referenceMap.get(diff);
        }

        if (isChangedProperty(diff)) {
            if (this.isValueType(diff.$formerValue) || this.isValueLike(diff.$formerValue)) {
                return diff.$formerValue;
            }
            return this.unwrapFormerInternal(diff.$formerValue, referenceMap);
        }

        if (isUnchangeProperty(diff)) {
            if (this.isValueType(diff.$value) || this.isValueLike(diff.$value)) {
                return diff.$value;
            }
            return this.unwrapFormerInternal(diff.$value, referenceMap);
        }

        if (isArrayDiff(diff)) {
            const formerArray: any = [];
            referenceMap.set(diff, formerArray);

            formerArray.push(...diff.$other.map((x) => this.isValueType(x) || this.isValueLike(x) ? x : this.unwrapFormerInternal(x, referenceMap)));
            formerArray.push(...diff.$deleted.map((x) => this.isValueType(x) || this.isValueLike(x) ? x : this.unwrapFormerInternal(x, referenceMap)));

            const objectId = (diff as any)[objectIdSymbol];
            if (objectId) {
                formerArray[objectIdSymbol] = objectId;
            }

            return formerArray;
        }

        if (isObjectDiff(diff)) {
            const formerObject: any = {};
            referenceMap.set(diff, formerObject);
            for (const propertyResult of Array.from(this.getPropertyKeys(diff))
                .filter((x) => x !== "$state")
                .filter((x) => x !== "$isCreated")
                .filter((x) => x !== "$isDeleted")
                .filter((x) => x !== "$isChanged")
                .filter((x) => x !== "$isDirty")
                .filter((x) => x !== "$unwrap")
                .map((property) => ({ property, result: this.unwrapFormerInternal((diff as any)[property], referenceMap) }))) {

                const objectId = (diff as any)[objectIdSymbol];
                if (objectId) {
                    formerObject[objectIdSymbol] = objectId;
                }

                formerObject[propertyResult.property] = propertyResult.result;
            }

            return formerObject;
        }

        return diff;
    }

    private unwrapPresentInternal(diff: any, referenceMap: Map<any, any>): any {
        if (referenceMap.has(diff)) {
            return referenceMap.get(diff);
        }

        if (isPropertyDiff(diff)) {
            if (this.isValueType(diff.$value) || this.isValueLike(diff.$value)) {
                return diff.$value;
            }
            return this.unwrapPresentInternal(diff.$value, referenceMap);
        }

        if (isArrayDiff(diff)) {
            const presentArray: any = [];
            referenceMap.set(diff, presentArray);

            presentArray.push(...diff.$other.map((x) => this.isValueType(x) || this.isValueLike(x) ? x : this.unwrapPresentInternal(x, referenceMap)));
            presentArray.push(...diff.$inserted.map((x) => this.isValueType(x) || this.isValueLike(x) ? x : this.unwrapPresentInternal(x, referenceMap)));

            const objectId = (diff as any)[objectIdSymbol];
            if (objectId) {
                presentArray[objectIdSymbol] = objectId;
            }

            return presentArray;
        }

        if (isObjectDiff(diff)) {
            const presentObject: any = {};
            referenceMap.set(diff, presentObject);
            for (const propertyResult of Array.from(this.getPropertyKeys(diff))
                .filter((x) => x !== "$state")
                .filter((x) => x !== "$isCreated")
                .filter((x) => x !== "$isDeleted")
                .filter((x) => x !== "$isChanged")
                .filter((x) => x !== "$isDirty")
                .filter((x) => x !== "$unwrap")
                .map((property) => ({ property, result: this.unwrapPresentInternal((diff as any)[property], referenceMap) }))) {

                presentObject[propertyResult.property] = propertyResult.result;
            }

            const objectId = (diff as any)[objectIdSymbol];
            if (objectId) {
                presentObject[objectIdSymbol] = objectId;
            }

            return presentObject;
        }

        return diff;
    }

    private isDirtyInternal(diff: any, referenceSet: Set<any>): boolean {
        if (referenceSet.has(diff)) {
            return false;
        }
        referenceSet.add(diff);

        if (isPropertyDiff(diff)) {
            if (diff.$isChanged) {
                return true;
            }

            if (this.isValueType(diff.$value) || this.isValueLike(diff.$value)) {
                return false;
            }

            if (this.isDirtyInternal(diff.$value, referenceSet)) {
                return true;
            }
        }

        if (isObjectDiff(diff)) {
            if (diff.$isChanged || diff.$isCreated || diff.$isDeleted) {
                return true;
            }

            for (const key of this.getPropertyKeys(diff)) {
                const property = (diff as any)[key];
                if (this.isDirtyInternal(property, referenceSet)) {
                    return true;
                }
            }

            return false;
        }

        if (isArrayDiff(diff)) {
            if (diff.$isChanged || diff.$isCreated || diff.$isDeleted) {
                return true;
            }

            for (const item of diff.$other) {
                if (this.isValueType(item) || this.isValueLike(item)) {
                    continue;
                }

                if (this.isObject(item) && this.isDirtyInternal(item, referenceSet)) {
                    return true;
                }
            }
        }

        return false;
    }

    private isObject(node: any): boolean {
        return typeof node === "object" && node !== null;
    }

    private isValueType(node: any): node is ValueType {
        return node == undefined ||
            typeof node === "string" ||
            typeof node === "number" ||
            typeof node === "boolean";
    }

    private isValueLike(node: any): node is ValueLike {
        return this.isObject(node) && this.valueLikePlugins.some((x) => x.isMatch(node));
    }

    private isReference(node: any): node is { [objectIdSymbol]: string; } {
        return this.isObject(node) && node[objectIdSymbol] !== undefined;
    }
}

export function isArrayDiff<T>(node: IArrayDiff<T> | any): node is IArrayDiff<T> {
    return node instanceof ArrayDiffImpl;
}

export function isObjectDiff<T>(node: ObjectDiff<T> | any): node is ObjectDiff<T> {
    return node instanceof ObjectDiffImpl;
}

export function isPropertyDiff<T>(node: PropertyDiff<T> | any): node is PropertyDiff<T> {
    return node instanceof PropertyDiffImpl;
}

export function isUnchangeProperty<T>(node: IUnchangedProperty<T> | any): node is IUnchangedProperty<T> {
    return node instanceof PropertyDiffImpl && !node.$isChanged;
}

export function isChangedProperty<T>(node: IChangedProperty<T> | any): node is IChangedProperty<T> {
    return node instanceof PropertyDiffImpl && node.$isChanged;
}

export interface IObjectEntity {
    [objectIdSymbol]: string;
}

export interface IReferenceLikePlugin<T> {
    name: string;
    isMatch: (instance: any) => instance is T;
    isValueLikePlugin: false;

    clone?: (context: ICloneContext, instance: T) => T;
}

export interface IValueLikePlugin<T> {
    name: string;
    isMatch: (instance: any) => instance is T;
    isValueLikePlugin: true;

    clone: (context: ICloneContext, instance: T) => T;
    equals: (left: T, right: T) => boolean;
}

export interface ICloneContext {
    clone<T>(obj: T): T;
}

interface IObjectLookupEntry {
    formerObject: any;
    presentObject: any;
    propertyKeys: Set<string>;
    diff: any;
}

class PropertyDiffImpl {
    public $isChanged: boolean;
    public $value: any;
    public $formerValue: any;
    public $isDirty: () => boolean;
    public $unwrap: (era: Era) => any;

    constructor(
        $isChanged: boolean,
        isDirty: (diff: any) => boolean,
        unwrap: (era: Era, diff: any) => any,
        $value: any,
        $formerValue?: any) {
        this.$isChanged = $isChanged;
        this.$value = $value;
        this.$formerValue = $formerValue;
        this.$isDirty = () => isDirty(this);
        this.$unwrap = (era: Era) => unwrap(era, this);
    }
}

const $isCreatedSymbol: unique symbol = Symbol.for("internalIsCreatedSymbol");
const $isDeletedSymbol: unique symbol = Symbol.for("internalIsDeletedSymbol");
const $isChangedSymbol: unique symbol = Symbol.for("internalIsChangedSymbol");
const $isDirtySymbol: unique symbol = Symbol.for("internalIsDirtySymbol");
const $unwrapSymbol: unique symbol = Symbol.for("internalUnwrapSymbol");
class ObjectDiffImpl {
    public [objectIdSymbol]: string = undefined!;

    // internal
    public [$isCreatedSymbol]: boolean = false;
    public [$isDeletedSymbol]: boolean = false;
    public [$isChangedSymbol]: boolean = false;
    // internal

    private [$isDirtySymbol]: (diff: any) => boolean;
    private [$unwrapSymbol]: (era: Era, diff: any, referenceMap: Map<any, any>) => any;

    constructor($isDirty: (diff: any) => boolean, $unwrap: (era: Era, diff: any) => any) {
        this[$isDirtySymbol] = $isDirty;
        this[$unwrapSymbol] = $unwrap;
    }

    public get $isCreated(): boolean {
        return this[$isCreatedSymbol];
    }

    public get $isDeleted(): boolean {
        return this[$isDeletedSymbol];
    }

    public get $isChanged(): boolean {
        return this[$isChangedSymbol];
    }

    public $isDirty(): boolean {
        return this[$isDirtySymbol](this);
    }

    public $unwrap(era: Era = Era.Present): boolean {
        return this[$unwrapSymbol](era, this, new Map());
    }

    public get $state(): State {
        return this.$isChanged ? State.Changed
            : this.$isCreated ? State.Created
                : this.$isDeleted ? State.Deleted
                    : State.Unchanged;
    }
}

class ArrayDiffImpl {
    public [objectIdSymbol]: string = undefined!;

    public $inserted: any[] = [];
    public $deleted: any[] = [];
    public $other: any[] = [];
    public $isCreated: boolean = false;
    public $isDeleted: boolean = false;
    public $isChanged: boolean = false;

    private [$isDirtySymbol]: (diff: any) => boolean;
    private [$unwrapSymbol]: (era: Era, diff: any) => any;

    // tslint:disable-next-line: variable-name => we carry a private ref to parent change checker for performance reasons
    constructor($isDirty: (diff: any) => boolean, $unwrap: (era: Era, diff: any) => any) {
        this[$isDirtySymbol] = $isDirty;
        this[$unwrapSymbol] = $unwrap;
    }

    public $isDirty(): boolean {
        return this[$isDirtySymbol](this);
    }

    public $unwrap(era: Era = Era.Present): boolean {
        return this[$unwrapSymbol](era, this);
    }

    public get $state(): State {
        return this.$isChanged ? State.Changed
            : this.$isCreated ? State.Created
                : this.$isDeleted ? State.Deleted
                    : State.Unchanged;
    }
}
