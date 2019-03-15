import { ObjectDiff, IArrayDiff, IChangedProperty, IUnchangedProperty, ValueLike, ValueType, Era, PropertyDiff, State } from "./DiffTypes";

export const objectIdSymbol: unique symbol = Symbol.for("objectId");

export class ChangeChecker {
    private currentObjectId: number = 0;
    private referenceLikesPlugins: Array<IReferenceLikePlugin<any>> = [];
    private valueLikePlugins: Array<IValueLikePlugin<any>> = [];

    public withPlugin<T>(plugin: IReferenceLikePlugin<T> | IValueLikePlugin<T>): ChangeChecker {
        if (this.referenceLikesPlugins.some((x) => x.name === plugin.name) || this.valueLikePlugins.some((x) => x.name === plugin.name)) {
            throw new Error(`Plugin with name ${plugin.name} is already registered.`);
        }

        if (plugin.isValueLikePlugin) {
            this.valueLikePlugins.push(plugin);
        }
        else {
            this.referenceLikesPlugins.push(plugin);
        }

        return this;
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
        const objectLookup: Map<any, IObjectLookupEntry> = new Map();
        this.fillObjectLookupFormer(formerObject, objectLookup, new Set());
        this.fillObjectLookupPresent(presentObject, objectLookup, new Set());

        for (const entry of objectLookup.values()) {
            let result: ArrayDiffImpl | ObjectDiffImpl;
            if (Array.isArray(entry.formerObject || entry.presentObject)) {
                const $isCreated = entry.formerObject === null;
                const $isDeleted = entry.presentObject === null;

                result = new ArrayDiffImpl($isCreated, $isDeleted, false, this.isDirtyArrow, this.unwrapArrow);
            }
            else {
                const $isCreated = entry.formerObject === null;
                const $isDeleted = entry.presentObject === null;

                result = new ObjectDiffImpl($isCreated, $isDeleted, false, this.isDirtyArrow, this.unwrapArrow);
            }

            entry.diff = result;
        }

        for (const entry of objectLookup.values()) {
            if (Array.isArray(entry.formerObject || entry.presentObject)) {
                this.bindArrayDiff(objectLookup, entry);
            }
            else {
                this.bindObjectDiff(objectLookup, entry);
            }
        }

        return objectLookup.get(formerObject[objectIdSymbol])!.diff;
    }

    private bindObjectDiff(objectLookup: Map<string, IObjectLookupEntry>, lookupEntry: IObjectLookupEntry): void {
        if (lookupEntry.formerObject) {
            lookupEntry.diff[objectIdSymbol] = lookupEntry.formerObject[objectIdSymbol];
        }

        for (const propertyInfo of lookupEntry.propertyInfos.values()) {
            const formerValueOrReference = lookupEntry.formerObject ? lookupEntry.formerObject[propertyInfo.name] : undefined;
            const presentValueOrReference = lookupEntry.presentObject ? lookupEntry.presentObject[propertyInfo.name] : undefined;
            if (typeof formerValueOrReference === "function" || typeof presentValueOrReference === "function") {
                continue;
            }

            const propertyDiff: PropertyDiffImpl = this.createPropertyDiff(lookupEntry, formerValueOrReference, objectLookup, presentValueOrReference);

            Object.defineProperty(lookupEntry.diff, propertyInfo.name, {
                writable: propertyInfo.writable,
                value: propertyDiff,
                enumerable: propertyInfo.enumerable,
                configurable: propertyInfo.configurable
            });
        }
    }

    private createPropertyDiff(lookupEntry: IObjectLookupEntry, formerValueOrReference: any, objectLookup: Map<string, IObjectLookupEntry>, presentValueOrReference: any): PropertyDiffImpl {
        let propertyDiff: PropertyDiffImpl;
        if (lookupEntry.presentObject == undefined) {
            const $formerValue = this.resolveValueOrDiff(formerValueOrReference, objectLookup);
            propertyDiff = new PropertyDiffImpl(false, this.isDirtyArrow, this.unwrapArrow, $formerValue);
        }
        else if (lookupEntry.formerObject == undefined) {
            const $value = this.resolveValueOrDiff(presentValueOrReference, objectLookup);
            propertyDiff = new PropertyDiffImpl(false, this.isDirtyArrow, this.unwrapArrow, $value);
        }
        else {
            const $value = this.resolveValueOrDiff(presentValueOrReference, objectLookup);
            const $formerValue = this.resolveValueOrDiff(formerValueOrReference, objectLookup);
            const isSameValue = $formerValue === $value;
            const isSameReference = !isSameValue && this.isReference($formerValue) && this.isReference($value) && $formerValue[objectIdSymbol] === $value[objectIdSymbol];
            const isSameValueLike = !isSameValue && !isSameReference && this.isSameValueLike($formerValue, $value);
            if (isSameValue || isSameReference || isSameValueLike) {
                propertyDiff = new PropertyDiffImpl(false, this.isDirtyArrow, this.unwrapArrow, $value);
            }
            else {
                propertyDiff = new PropertyDiffImpl(true, this.isDirtyArrow, this.unwrapArrow, $value, $formerValue);
                lookupEntry.diff.$isChanged = true;
            }
        }
        return propertyDiff;
    }

    private bindArrayDiff(objectLookup: Map<string, IObjectLookupEntry>, lookupEntry: IObjectLookupEntry): void {
        if (lookupEntry.formerObject) {
            lookupEntry.diff[objectIdSymbol] = lookupEntry.formerObject[objectIdSymbol];
        }

        if (lookupEntry.presentObject === null) {
            for (const item of lookupEntry.formerObject) {
                lookupEntry.diff.$other.push(this.resolveValueOrDiff(item, objectLookup));
            }
        }

        if (lookupEntry.formerObject === null) {
            for (const item of lookupEntry.presentObject) {
                if (typeof item === "function") {
                    continue;
                }
                lookupEntry.diff.$other.push(this.resolveValueOrDiff(item, objectLookup));
            }
        }

        if (lookupEntry.formerObject && lookupEntry.presentObject) {
            // this map holds all possible results as key. The inner arrays 1st index holds the occurrences of the former array and the 2nd index holds the occurrences of the present array.
            const resultMap: Map<any, [any[], any[]]> = new Map();
            for (const item of lookupEntry.presentObject) {
                if (typeof item === "function") {
                    continue;
                }

                const arrayDiffEntry = this.resolveValueOrDiff(item, objectLookup);
                const entry = resultMap.get(arrayDiffEntry);
                if (entry) {
                    entry[1].push(arrayDiffEntry);
                }
                else {
                    resultMap.set(arrayDiffEntry, [[], [arrayDiffEntry]]);
                }
            }

            for (const item of lookupEntry.formerObject) {
                const arrayDiffEntry = this.resolveValueOrDiff(item, objectLookup);
                const entry = resultMap.get(arrayDiffEntry);
                if (entry) {
                    entry[0].push(arrayDiffEntry);
                }
                else {
                    resultMap.set(arrayDiffEntry, [[arrayDiffEntry], []]);
                }
            }

            // now we know all past and present number of occurrences.

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

                // now we know what happend to the elements and push the results to the diff

                // tslint:disable:curly
                for (let i = 0; i < deleted.length; lookupEntry.diff.$deleted.push(deleted[i++])) continue;
                for (let i = 0; i < inserted.length; lookupEntry.diff.$inserted.push(inserted[i++])) continue;
                for (let i = 0; i < other.length; lookupEntry.diff.$other.push(other[i++])) continue;
                // tslint:enable:curly

                // we delete the entry to get a smaller set for the next loop ("value like" handling).
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

                // now we know what happend to the elements and push the results to the diff

                // tslint:disable:curly
                for (let i = 0; i < deleted.length; lookupEntry.diff.$deleted.push(deleted[i++])) continue;
                for (let i = 0; i < inserted.length; lookupEntry.diff.$inserted.push(inserted[i++])) continue;
                for (let i = 0; i < other.length; lookupEntry.diff.$other.push(other[i++])) continue;
                // tslint:enable:curly
            }
        }

        lookupEntry.diff.$isChanged = lookupEntry.diff.$inserted.length > 0 || lookupEntry.diff.$deleted.length > 0;
    }

    private fillObjectLookupFormer(former: any, objectLookup: Map<any, IObjectLookupEntry>, referenceSet: Set<any>): void {
        if (Array.isArray(former)) {
            if (referenceSet.has(former)) {
                return;
            }
            referenceSet.add(former);

            this.fillObjectLookupFormerArray(former, objectLookup, referenceSet);
            return;
        }

        if (typeof former === "object" && former !== null) {
            if (this.isValueLike(former)) {
                return;
            }

            if (referenceSet.has(former)) {
                return;
            }
            referenceSet.add(former);

            this.fillObjectLookupFormerObject(former, objectLookup, referenceSet);
        }
    }

    private fillObjectLookupFormerArray(formerArray: any[], objectLookup: Map<any, IObjectLookupEntry>, referenceSet: Set<any>): void {
        const lookupKey = (formerArray as any)[objectIdSymbol];

        let lookupEntry: IObjectLookupEntry | undefined = objectLookup.get(lookupKey);
        if (lookupEntry == undefined) {
            lookupEntry = {
                formerObject: formerArray,
                presentObject: null,
                propertyInfos: new Map(),
                diff: null
            };
            objectLookup.set(lookupKey, lookupEntry);
        }
        else {
            lookupEntry.formerObject = formerArray;
        }

        for (const item of formerArray) {
            this.fillObjectLookupFormer(item, objectLookup, referenceSet);
        }
    }

    private fillObjectLookupFormerObject(formerObject: any, objectLookup: Map<any, IObjectLookupEntry>, referenceSet: Set<any>): void {
        const lookupKey = (formerObject as any)[objectIdSymbol];

        let lookupEntry: IObjectLookupEntry | undefined = objectLookup.get(lookupKey);
        const propertyInfos = this.getPropertyInfos(formerObject);
        if (lookupEntry == undefined) {
            lookupEntry = {
                formerObject,
                presentObject: null,
                propertyInfos,
                diff: null
            };
            objectLookup.set(lookupKey, lookupEntry);
        }
        else {
            propertyInfos.forEach((info, key) => lookupEntry!.propertyInfos.set(key, info));
            lookupEntry.formerObject = formerObject;
        }

        for (const propertyKey of propertyInfos.keys()) {
            const property = formerObject[propertyKey];
            this.fillObjectLookupFormer(property, objectLookup, referenceSet);
        }
    }

    private fillObjectLookupPresent(present: any, objectLookup: Map<any, IObjectLookupEntry>, referenceSet: Set<any>): void {
        if (Array.isArray(present)) {
            if (referenceSet.has(present)) {
                return;
            }
            referenceSet.add(present);

            this.fillObjectLookupPresentArray(present, objectLookup, referenceSet);
            return;
        }

        if (typeof present === "object" && present !== null) {
            if (this.isValueLike(present)) {
                return;
            }

            if (referenceSet.has(present)) {
                return;
            }
            referenceSet.add(present);

            this.fillObjectLookupPresentObject(present, objectLookup, referenceSet);
        }
    }

    private fillObjectLookupPresentArray(presentArray: any[], objectLookup: Map<any, IObjectLookupEntry>, referenceSet: Set<any>): void {
        const lookupKey = (presentArray as any)[objectIdSymbol] || presentArray;

        let lookupEntry: IObjectLookupEntry | undefined = objectLookup.get(lookupKey);
        if (lookupEntry == undefined) {
            lookupEntry = {
                formerObject: null,
                presentObject: presentArray,
                propertyInfos: new Map(),
                diff: null
            };
            objectLookup.set(lookupKey, lookupEntry);
        }
        else {
            lookupEntry.presentObject = presentArray;
        }

        for (const item of presentArray) {
            this.fillObjectLookupPresent(item, objectLookup, referenceSet);
        }
    }

    private fillObjectLookupPresentObject(presentObject: any, objectLookup: Map<any, IObjectLookupEntry>, referenceSet: Set<any>): void {
        const lookupKey = (presentObject as any)[objectIdSymbol] || presentObject;

        let lookupEntry: IObjectLookupEntry | undefined = objectLookup.get(lookupKey);
        const propertyInfos = this.getPropertyInfos(presentObject);
        if (lookupEntry == undefined) {
            lookupEntry = {
                formerObject: null,
                presentObject,
                propertyInfos,
                diff: null
            };
            objectLookup.set(lookupKey, lookupEntry);
        }
        else {
            propertyInfos.forEach((info, key) => lookupEntry!.propertyInfos.set(key, info));
            lookupEntry.presentObject = presentObject;
        }

        for (const propertyKey of propertyInfos.keys()) {
            const property = presentObject[propertyKey];
            this.fillObjectLookupPresent(property, objectLookup, referenceSet);
        }
    }

    private clone(any: any, referenceMap: Map<any, any>): any {
        const circularDependency = referenceMap.get(any);
        if (circularDependency) {
            return circularDependency;
        }

        if (any == undefined) {
            return any;
        }

        if (this.isValueType(any)) {
            return any;
        }

        if (typeof any === "function") {
            return;
        }

        let plugin: IValueLikePlugin<any> | IReferenceLikePlugin<any> | undefined = this.valueLikePlugins.find((x) => x.isMatch(any));
        if (plugin) {
            return plugin.clone({ clone: <T>(x: T) => this.clone(x, referenceMap) }, any);
        }

        let result: any;

        plugin = this.referenceLikesPlugins.find((x) => x.clone != undefined && x.isMatch(any));
        if (plugin) {
            result = plugin.clone!({ clone: <T>(x: T) => this.clone(x, referenceMap) }, any);
            referenceMap.set(any, result);
        }
        else if (Array.isArray(any)) {
            result = this.cloneArray(any, referenceMap);
        }
        else {
            result = this.cloneObject(any, referenceMap);
        }

        setObjectIdRaw(result, any[objectIdSymbol]);
        return result;
    }

    private cloneArray(source: any[], referenceMap: Map<any, any>): any[] {
        const clone: any[] = [];
        referenceMap.set(source, clone);

        for (const item of source) {
            if (typeof item === "function") {
                continue;
            }

            if (typeof item === "object" && item !== null) {
                clone.push(this.clone(item, referenceMap));
            }
            else {
                clone.push(item);
            }
        }

        return clone;
    }

    private cloneObject(source: any, referenceMap: Map<any, any>): any {
        const clone = {};
        referenceMap.set(source, clone);

        for (const propertyInfo of this.getPropertyInfos(source).values()) {
            const property = source[propertyInfo.name];

            if (typeof property === "function") {
                continue;
            }

            let value: any;
            if (typeof property === "object" && property !== null) {
                value = this.clone(property, referenceMap);
            }
            else {
                value = property;
            }

            Object.defineProperty(clone, propertyInfo.name, {
                enumerable: propertyInfo.enumerable,
                writable: propertyInfo.writable,
                configurable: propertyInfo.configurable,
                value
            });
        }
        return clone;
    }

    private assignObjectIds(obj: any, referenceSet: Set<any>): void {
        if (referenceSet.has(obj)) {
            return;
        }
        referenceSet.add(obj);

        if (obj[objectIdSymbol] == undefined) {
            setObjectIdRaw(obj, this.getNextObjectId().toString());
        }

        if (Array.isArray(obj)) {
            for (const item of obj) {
                if (typeof item === "function") {
                    continue;
                }

                if (typeof item === "object" && item !== null) {
                    if (this.isValueLike(item)) {
                        continue;
                    }

                    this.assignObjectIds(item, referenceSet);
                }
            }
        }
        else {
            for (const key of this.getPropertyInfos(obj).keys()) {
                const value = obj[key];
                if (typeof value === "function") {
                    continue;
                }

                if (typeof value === "object" && value !== null) {
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
            if (objectId) {
                return lookup.get(objectId)!.diff;
            }

            const entry = lookup.get(valueOrReference);
            // in this case we used the presentObject as lookup key
            if (entry) {
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

    private getPropertyInfos(obj: any): Map<string, IPropertyInfo> {
        const result = new Map<string, IPropertyInfo>();

        if (obj == undefined) {
            return result;
        }

        for (let prototype = obj; prototype && prototype !== Object.prototype; prototype = Object.getPrototypeOf(prototype)) {
            for (const name of Object.getOwnPropertyNames(prototype)) {
                if (result.has(name)) {
                    continue;
                }

                if ((name[0] === "_" && name[1] === "_") || name === "constructor") {
                    // ignore constructor, system-defined and set only properties
                    continue;
                }

                const descriptor = Object.getOwnPropertyDescriptor(prototype, name)!;
                if (descriptor.set && descriptor.get == undefined) {
                    continue;
                }

                result.set(name, {
                    name,
                    enumerable: descriptor.enumerable === true,
                    writable: descriptor.writable === true || descriptor.set != undefined,
                    configurable: descriptor.configurable === true
                });
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

            return formerArray;
        }

        if (isObjectDiff(diff)) {
            const formerObject: any = {};
            referenceMap.set(diff, formerObject);
            // TODO: take care about incoming prototype chain
            for (const propertyResult of Array.from(this.getPropertyInfos(diff).values())
                .filter((x) => x.name !== "$state")
                .filter((x) => x.name !== "$isCreated")
                .filter((x) => x.name !== "$isDeleted")
                .filter((x) => x.name !== "$isChanged")
                .filter((x) => x.name !== "$isDirty")
                .filter((x) => x.name !== "$unwrap")
                .map((property) => ({ property, result: this.unwrapFormerInternal((diff as any)[property.name], referenceMap) }))) {

                Object.defineProperty(formerObject, propertyResult.property.name, {
                    configurable: propertyResult.property.configurable,
                    enumerable: propertyResult.property.enumerable,
                    writable: propertyResult.property.writable,
                    value: propertyResult.result
                });
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

            return presentArray;
        }

        if (isObjectDiff(diff)) {
            const presentObject: any = {};
            referenceMap.set(diff, presentObject);
            for (const propertyResult of Array.from(this.getPropertyInfos(diff).values())
                .filter((x) => x.name !== "$state")
                .filter((x) => x.name !== "$isCreated")
                .filter((x) => x.name !== "$isDeleted")
                .filter((x) => x.name !== "$isChanged")
                .filter((x) => x.name !== "$isDirty")
                .filter((x) => x.name !== "$unwrap")
                .map((property) => ({ property, result: this.unwrapPresentInternal((diff as any)[property.name], referenceMap) }))) {

                Object.defineProperty(presentObject, propertyResult.property.name, {
                    configurable: propertyResult.property.configurable,
                    enumerable: propertyResult.property.enumerable,
                    writable: propertyResult.property.writable,
                    value: propertyResult.result
                });
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

            return this.isDirtyInternal(diff.$value, referenceSet);
        }

        if (isObjectDiff(diff)) {
            if (diff.$isChanged || diff.$isCreated || diff.$isDeleted) {
                return true;
            }

            for (const key of this.getPropertyInfos(diff).keys()) {
                const property = (diff as any)[key];
                if (!isPropertyDiff(property)) {
                    continue;
                }

                if (this.isDirtyInternal(property, referenceSet)) {
                    return true;
                }
            }
        }

        if (isArrayDiff(diff)) {
            if (diff.$isChanged || diff.$isCreated || diff.$isDeleted) {
                return true;
            }

            for (const item of diff.$other) {
                if (this.isValueType(item) || this.isValueLike(item)) {
                    continue;
                }

                if (typeof item === "object" && item !== null && this.isDirtyInternal(item, referenceSet)) {
                    return true;
                }
            }
            return false;
        }

        return false;
    }

    private isValueType(node: any): node is ValueType {
        return node == undefined ||
            typeof node === "string" ||
            typeof node === "number" ||
            typeof node === "boolean";
    }

    private isValueLike(node: any): node is ValueLike {
        return typeof node === "object" && node !== null && this.valueLikePlugins.some((x) => x.isMatch(node));
    }

    private isReference(node: any): node is { [objectIdSymbol]: string; } {
        return typeof node === "object" && node !== null && node[objectIdSymbol] !== undefined;
    }
}

export function setObjectId<T extends IObjectEntity>(object: T, typeName: string, ...propertyKeys: Array<keyof T>): void {
    let objectId = typeName;
    for (const propertyKey of propertyKeys) {
        objectId += "_" + object[propertyKey];
    }

    setObjectIdRaw(object, objectId);
}

export function setObjectIdRaw(object: any, objectId: string): void {
    object[objectIdSymbol] = objectId;
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
    propertyInfos: Map<string, IPropertyInfo>;
    diff: any;
}

interface IPropertyInfo {
    name: string;
    enumerable: boolean;
    writable: boolean;
    configurable: boolean;
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
        unwrap: (era: Era, diff: any, referenceMap: Map<any, any>) => any,
        $value: any,
        $formerValue?: any) {
        this.$isChanged = $isChanged;
        this.$value = $value;
        this.$formerValue = $formerValue;
        this.$isDirty = () => isDirty(this);
        this.$unwrap = (era: Era) => unwrap(era, this, new Map());
    }
}

const internalIsCreatedSymbol: unique symbol = Symbol.for("internalIsCreatedSymbol");
const internalIsDeletedSymbol: unique symbol = Symbol.for("internalIsDeletedSymbol");
const internalIsChangedSymbol: unique symbol = Symbol.for("internalIsChangedSymbol");
const internalIsDirtySymbol: unique symbol = Symbol.for("internalIsDirtySymbol");
const internalUnwrapSymbol: unique symbol = Symbol.for("internalUnwrapSymbol");
class ObjectDiffImpl {
    public [objectIdSymbol]: string = undefined!;

    private [internalIsCreatedSymbol]: boolean;
    private [internalIsDeletedSymbol]: boolean;
    private [internalIsChangedSymbol]: boolean;
    private [internalIsDirtySymbol]: (diff: any) => boolean;
    private [internalUnwrapSymbol]: (era: Era, diff: any, referenceMap: Map<any, any>) => any;

    // tslint:disable-next-line: variable-name => we carry a private ref to parent change checker for performance reasons
    constructor(
        $isCreated: boolean,
        $isDeleted: boolean,
        $isChanged: boolean,
        $isDirty: (diff: any) => boolean,
        $unwrap: (era: Era, diff: any) => any) {
        this[internalIsCreatedSymbol] = $isCreated;
        this[internalIsDeletedSymbol] = $isDeleted;
        this[internalIsChangedSymbol] = $isChanged;
        this[internalIsDirtySymbol] = $isDirty;
        this[internalUnwrapSymbol] = $unwrap;
    }

    public get $isCreated(): boolean {
        return this[internalIsCreatedSymbol];
    }

    public get $isDeleted(): boolean {
        return this[internalIsDeletedSymbol];
    }

    public get $isChanged(): boolean {
        return this[internalIsChangedSymbol];
    }

    public set $isChanged(value: boolean) {
        this[internalIsChangedSymbol] = value;
    }

    public $isDirty(): boolean {
        return this[internalIsDirtySymbol](this);
    }

    public $unwrap(era: Era = Era.Present): boolean {
        return this[internalUnwrapSymbol](era, this, new Map());
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
    public $isCreated: boolean;
    public $isDeleted: boolean;
    public $isChanged: boolean = false;

    private [internalIsDirtySymbol]: (diff: any) => boolean;
    private [internalUnwrapSymbol]: (era: Era, diff: any) => any;

    // tslint:disable-next-line: variable-name => we carry a private ref to parent change checker for performance reasons
    constructor($isCreated: boolean,
        $isDeleted: boolean,
        $isChanged: boolean,
        $isDirty: (diff: any) => boolean,
        $unwrap: (era: Era, diff: any) => any) {
        this.$isCreated = $isCreated;
        this.$isDeleted = $isDeleted;
        this.$isChanged = $isChanged;
        this[internalIsDirtySymbol] = $isDirty;
        this[internalUnwrapSymbol] = $unwrap;
    }

    public $isDirty(): boolean {
        return this[internalIsDirtySymbol](this);
    }

    public $unwrap(era: Era = Era.Present): boolean {
        return this[internalUnwrapSymbol](era, this);
    }

    public get $state(): State {
        return this.$isChanged ? State.Changed
            : this.$isCreated ? State.Created
                : this.$isDeleted ? State.Deleted
                    : State.Unchanged;
    }
}
