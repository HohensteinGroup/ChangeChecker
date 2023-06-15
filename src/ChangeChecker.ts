import { Era, IArrayDiff, IChangedProperty, IUnchangedProperty, ObjectDiff, PropertyDiff, State, ValueLike, ValueType } from "./DiffTypes";
import { ChangeCheckerObjectConflictError } from "./Errors";

export const objectIdSymbol: unique symbol = Symbol.for("objectId");

export class ChangeChecker {
    private currentObjectId: number = 0;
    private referenceLikePlugins: Array<IReferenceLikePlugin<any>> = [];
    private valueLikePlugins: Array<IValueLikePlugin<any>> = [];

    // To avoid v8 deoptimizations we use a global lookup map and not a new map that we pass around as parameter.
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

        // Everytime someone takes a snapshot we add objectId's to all objects in the model to be able to compare them later against the clone's objects (the snapshot).
        this.assignObjectIds(model, new Set());
        return this.clone(model, new Map()) as T;
    }

    public createDiff<T>(snapshot: T[], currentModel: T[]): IArrayDiff<T>;
    public createDiff<T extends object>(snapshot: T, currentModel: T): ObjectDiff<T>;
    public createDiff<T>(snapshot: T, currentModel: T): IArrayDiff<T> | ObjectDiff<T> {
        if (!this.isReference(snapshot) || !this.isReference(currentModel) || snapshot[objectIdSymbol] !== currentModel[objectIdSymbol]) {
            // If the root object is not the same we can't compare them because we need a starting point to compare the objects.
            throw new Error("Parameter 'snapshot' and parameter 'currentModel' have to share the same root ('objectId' differs or may not present).");
        }

        this.globalLookup.clear();
        return this.createDiffInternal(snapshot, currentModel);
    }

    public mergeSnapshotInto<TModel extends object>(model: TModel, applyChanges: (merger: ISnapshotMerger<TModel>) => void): void {
        this.mergeSnapshotIntoPart(model, model, applyChanges);
    }

    // This method is used to merge a snapshot into a part of the model. This is done by using a proxy membrane.
    // Everytime a property is set on the proxy membrane we check if any value in the object graph is an object with an objectId and if so we replace the object everywhere in the target instead of just the one property the user is setting it to.
    public mergeSnapshotIntoPart<TModel extends object, TModelPartToUpdate extends object>(model: TModel, modelPartToUpdate: TModelPartToUpdate, applyChanges: (merger: ISnapshotMerger<TModelPartToUpdate>) => void): void {
        const proxify = <T extends object>(object: T) => {
            return new Proxy(object, {
                set: (target, propertyName, newValueOrObject): boolean => {
                    (target as any)[propertyName] = newValueOrObject;

                    const isObject = !this.isValueType(newValueOrObject) && !this.isValueLike(newValueOrObject);
                    if (isObject) {
                        this.mergeSnapshotIntoModel(model, newValueOrObject);
                    }

                    return true;
                },
                get: (target, propertyName): any => {
                    const propertyValue = (target as any)[propertyName];
                    const isObject = !this.isValueType(propertyValue) && !this.isValueLike(propertyValue);
                    if (isObject) {
                        return proxify(propertyValue);
                    }

                    return propertyValue;
                }
            });
        };

        const snapshotMerger: ISnapshotMerger<TModelPartToUpdate> = {
            target: modelPartToUpdate
        };

        const proxyMembrane = proxify(snapshotMerger);
        applyChanges(proxyMembrane);
    }

    // For performance reasons we instantiate a single instance of this two functions for later use for every diff we create.
    private isDirtyArrow = (diff: any) => this.isDirtyInternal(diff, new Set());
    private unwrapArrow = (era: Era, diff: any) => era === Era.Present
        ? this.unwrapPresentInternal(diff, new Map())
        : this.unwrapFormerInternal(diff, new Map())

    private createDiffInternal(formerObject: any, presentObject: any): any {
        // Build a lookup where each entry contains the (optional) former and (optional) present object, the property keys, and an instance of the diff object (ArrayDiff or ObjectDiff).
        const globalLookup = this.buildLookupTree(formerObject, presentObject);

        // Then we just loop over all entries in the lookup and forward the entry to the correct method to build the diff.
        for (const entry of globalLookup.values()) {
            if (Array.isArray(entry.formerObject || entry.presentObject)) {
                this.bindArrayDiff(entry, globalLookup);
            }
            else {
                this.bindObjectDiff(entry, globalLookup);
            }
        }

        // Last but not least we return the diff of the root object.
        const result = globalLookup.get(formerObject[objectIdSymbol])!.diff;
        return result;
    }

    private bindObjectDiff(lookupEntry: IObjectLookupEntry, globalLookup: Map<any, IObjectLookupEntry>): void {
        // If the former object is null we know that the object was created.
        lookupEntry.diff[$isCreatedSymbol] = lookupEntry.formerObject === null;
        // If the present object is null we know that the object was deleted.
        lookupEntry.diff[$isDeletedSymbol] = lookupEntry.presentObject === null;

        if (lookupEntry.formerObject) {
            // The former object has always an objectId so we assign the objectId to the diff object so we can later on match the diff object with the former object or
            // reconstruct the former object from the diff object (see unwrapFormerInternal).
            lookupEntry.diff[objectIdSymbol] = lookupEntry.formerObject[objectIdSymbol];
        }

        // Loop over all property keys that are present in the former or present object (both can have a different set of properties).
        for (const propertyKey of lookupEntry.propertyKeys) {
            // Get the property value for the property key from both the former and present object.
            const formerValueOrReference = lookupEntry.formerObject ? lookupEntry.formerObject[propertyKey] : undefined;
            const presentValueOrReference = lookupEntry.presentObject ? lookupEntry.presentObject[propertyKey] : undefined;

            // If the property value is a function we ignore it because we can't diff functions.
            if (typeof formerValueOrReference === "function" || typeof presentValueOrReference === "function") {
                continue;
            }

            // Create the property diff object and assign it to the diff object to the property key.
            const propertyDiff: PropertyDiffImpl = this.createPropertyDiff(lookupEntry, globalLookup, formerValueOrReference, presentValueOrReference);
            lookupEntry.diff[propertyKey] = propertyDiff;
        }
    }

    private createPropertyDiff(lookupEntry: IObjectLookupEntry, globalLookup: Map<any, IObjectLookupEntry>, formerValueOrReference: any, presentValueOrReference: any): PropertyDiffImpl {
        let propertyDiff: PropertyDiffImpl;

        // If the object the property is located on is not present in the present model we can just infer that the property was deleted with the object.
        if (lookupEntry.presentObject === null) {
            // Resolve the value (e.g. string, number, boolean, null, undefined etc.), value like (e.g. Date, RegExp etc.) or the diff object (ArrayDiff or ObjectDiff) using
            // the objectId of the former object (see resolveValueOrDiff).
            const $formerValue = this.resolveValueOrDiff(formerValueOrReference, globalLookup);
            propertyDiff = new PropertyDiffImpl(false, this.isDirtyArrow, this.unwrapArrow, $formerValue);
        }
        // If the object the property is located on is not present in the former model we can just infer that the property was created with the object.
        else if (lookupEntry.formerObject === null) {
            // Resolve the value (e.g. string, number, boolean, null, undefined etc.), value like (e.g. Date, RegExp etc.) or the diff object (ArrayDiff or ObjectDiff) using
            // the objectId of the present object (see resolveValueOrDiff).
            const $value = this.resolveValueOrDiff(presentValueOrReference, globalLookup);
            propertyDiff = new PropertyDiffImpl(false, this.isDirtyArrow, this.unwrapArrow, $value);
        }
        else {
            // If both the former and present object are present we need to check if the property value has changed.
            // First resolve the value, value like or diff object for the former and present object using the object id of the former and present object (see resolveValueOrDiff).
            const $value = this.resolveValueOrDiff(presentValueOrReference, globalLookup);
            const $formerValue = this.resolveValueOrDiff(formerValueOrReference, globalLookup);
            // Check if its the same value, value like or diff object.
            const isSameValue = $formerValue === $value;
            const isSameReference = !isSameValue && this.isReference($formerValue) && this.isReference($value) && $formerValue[objectIdSymbol] === $value[objectIdSymbol];
            const isSameValueLike = !isSameValue && !isSameReference && this.isSameValueLike($formerValue, $value);
            // If its the same value, value like or diff object we create an unchanged property diff object.
            if (isSameValue || isSameReference || isSameValueLike) {
                propertyDiff = new PropertyDiffImpl(false, this.isDirtyArrow, this.unwrapArrow, $value);
            }
            // Else we create a changed property diff object.
            else {
                propertyDiff = new PropertyDiffImpl(true, this.isDirtyArrow, this.unwrapArrow, $value, $formerValue);
                lookupEntry.diff[$isChangedSymbol] = true;
            }
        }

        return propertyDiff;
    }

    private bindArrayDiff(lookupEntry: IObjectLookupEntry, globalLookup: Map<any, IObjectLookupEntry>): void {
        // If the former array is null we know that the array was created.
        lookupEntry.diff.$isCreated = lookupEntry.formerObject === null;
        // If the present array is null we know that the array was deleted.
        lookupEntry.diff.$isDeleted = lookupEntry.presentObject === null;

        if (lookupEntry.formerObject) {
            // The former array has always an objectId so we assign the objectId to the diff object so we can later on match the diff object with the former array or
            // reconstruct the former array from the diff object (see unwrapFormerInternal).
            lookupEntry.diff[objectIdSymbol] = lookupEntry.formerObject[objectIdSymbol];
        }

        if (lookupEntry.presentObject === null) {
            // If the present array is null we know that the array was deleted so we don't know whether or not items were added or removed so we just assign all items to the $other array.
            for (const item of lookupEntry.formerObject) {
                lookupEntry.diff.$other.push(this.resolveValueOrDiff(item, globalLookup));
            }
        }

        if (lookupEntry.formerObject === null) {
            // If the former array is null we know that the array was created so items were not added to the former array so we just assign all items to the $other array.
            for (const item of lookupEntry.presentObject) {
                if (typeof item === "function") {
                    continue;
                }
                lookupEntry.diff.$other.push(this.resolveValueOrDiff(item, globalLookup));
            }
        }

        // If both the former and present array are not null we need to check if items were added or removed.
        // This is quite complex to do in a performant way. For this reason we use arrays with two single entries to keep track of the occurrences of the items instead of
        // an object because array access is faster than object property access.
        if (lookupEntry.formerObject && lookupEntry.presentObject) {

            // This map holds all possible results as key. The inner arrays 1st index holds the occurrences of the former array and the 2nd index holds the occurrences of the present array.
            // Map<value, [formerOccurrences, presentOccurrences]>
            const resultMap: Map<any, [any[], any[]]> = new Map();

            // Iterate over all items of the present array.
            for (const item of lookupEntry.presentObject) {
                if (typeof item === "function") {
                    continue;
                }

                // Resolve the value, value like or diff object for the present object using the object id of the present object (see resolveValueOrDiff).
                const arrayDiffEntry = this.resolveValueOrDiff(item, globalLookup);
                const entry = resultMap.get(arrayDiffEntry);
                if (entry) {
                    // If the result map already contains the item we just increment the occurrences of the present array (at index 1).
                    entry[1].push(arrayDiffEntry);
                }
                else {
                    // Else we create a new entry with the first occurrence of the present array (at index 1).
                    resultMap.set(arrayDiffEntry, [[], [arrayDiffEntry]]);
                }
            }

            // Iterate over all items of the former array.
            for (const item of lookupEntry.formerObject) {
                const arrayDiffEntry = this.resolveValueOrDiff(item, globalLookup);
                const entry = resultMap.get(arrayDiffEntry);
                if (entry) {
                    // If the result map already contains the item we just increment the occurrences of the former array (at index 0).
                    entry[0].push(arrayDiffEntry);
                }
                else {
                    // Else we create a new entry with the first occurrence of the former array (at index 0).
                    resultMap.set(arrayDiffEntry, [[arrayDiffEntry], []]);
                }
            }

            // Now the result map contains all items of the former and present array and the occurrences of the items in the former and present array.
            // Example: If the former array is [1, 2, 3, 4] and the present array is [1, 2, 2, 3, 5] the result map would look like this:
            // Map {
            //     1 => [ [ 1 ], [ 1 ] ],
            //     2 => [ [ 2 ], [ 2, 2 ] ],
            //     3 => [ [ 3 ], [ 3 ] ],
            //     4 => [ [ 4 ], [] ],
            //     5 => [ [], [ 5 ] ]
            // }

            // Because we can not compare value likes by reference the result map can contain multiple entries with the same value like.
            // We will first handle all non value like entries and then handle all value like entries that will be stored in the valueLikes array.
            const valueLikes: Array<[any, [any[], any[]]]> = [];

            // Iterate over all entries of the result map.
            for (const entry of resultMap) {
                if (this.isValueLike(entry[0])) {
                    // Because maps and sets can not recognize "value likes" equality (new Date(1993, 3) != new Date(1993, 3) == true) we have to skip them for now and handle them later.
                    valueLikes.push(entry);
                    continue;
                }

                // The two arrays below will hold the occurrences of the same value or diff of the former and present array.
                // Example: If the former array is [1, 2, 3, 4] and the present array is [1, 2, 2, 3, 5] and we are in the second iteration of the result map the arrays will look like this:
                // formerOccurrences = [2]
                // presentOccurrences = [2, 2]
                const formerOccurrences = entry[1][0];
                const presentOccurrences = entry[1][1];

                // Example: If the formerOccurrences array is [2] and the presentOccurrences array is [2, 2] the deleted, inserted and other array's will look like this:

                // The deleted array will hold all items that were in the former array but not in the present array.
                // deleted = [] because formerOccurrences.length - presentOccurrences.length = -1 (and -1 is smaller than 0 so splice will return an empty array)
                const deleted = formerOccurrences.splice(0, formerOccurrences.length - presentOccurrences.length);

                // The inserted array will hold all items that were in the present array but not in the former array.
                // inserted = [2] because presentOccurrences.length - formerOccurrences.length = 1
                const inserted = presentOccurrences.splice(0, presentOccurrences.length - formerOccurrences.length);

                // The other array will hold all items that were in both the former and present array.
                // other = [2] because formerOccurrences.length = presentOccurrences.length = 1
                const other = inserted.length > 0 ? presentOccurrences : formerOccurrences;

                // tslint:disable:curly
                for (let i = 0; i < deleted.length; lookupEntry.diff.$deleted.push(deleted[i++])) continue;
                for (let i = 0; i < inserted.length; lookupEntry.diff.$inserted.push(inserted[i++])) continue;
                for (let i = 0; i < other.length; lookupEntry.diff.$other.push(other[i++])) continue;
                // tslint:enable:curly
            }

            // Now comes the tricky part. We have to handle all value like entries.
            // The value like array could look like this:
            // [
            //     [new Date(1993, 3), [[new Date(1993, 3)], []]],
            //     [new Date(1993, 3), [[], [new Date(1993, 3)]]],
            //     [new Date(1993, 3), [[new Date(1993, 3)], []]],
            //     [new Date(1993, 3), [[], [new Date(1993, 3)]]]
            // ]
            // Iterate over all value like entries.
            for (let outerIndex = 0; outerIndex < valueLikes.length; outerIndex++) {
                // Find the plugin that matches the value like.
                const plugin = this.valueLikePlugins.find((x) => x.isMatch(valueLikes[outerIndex][0]))!;

                // Because we did handle all entries that are < outerIndex already we can start with the next entry to find all matching value likes.
                for (let innerIndex = outerIndex + 1; innerIndex < valueLikes.length;) {
                    // If the plugin we found for our value like at outerIndex matches the value like at innerIndex and the values are equal we have a match.
                    if (plugin.isMatch(valueLikes[innerIndex][0]) && plugin.equals(valueLikes[outerIndex][0], valueLikes[innerIndex][0])) {
                        // We can now merge the two arrays of the matching value likes.
                        // tslint:disable:curly
                        for (let i = 0; i < valueLikes[innerIndex][1][0].length; valueLikes[outerIndex][1][0].push(valueLikes[innerIndex][1][0][i++])) continue;
                        for (let i = 0; i < valueLikes[innerIndex][1][1].length; valueLikes[outerIndex][1][1].push(valueLikes[innerIndex][1][1][i++])) continue;
                        // tslint:enable:curly

                        // Delete the matching value like to decrease the number of iterations.
                        valueLikes.splice(innerIndex, 1);
                    } else {
                        // If the plugin we found for our value like at outerIndex does not match the value like at innerIndex or the values are not equal we have no match.
                        innerIndex++;
                    }
                }
            }

            // As before we know all past and present number of occurrences and we can just apply the same logic as before for the non value like entries to the value like entries.
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

        // If any items were inserted or deleted we have a change.
        lookupEntry.diff.$isChanged = lookupEntry.diff.$inserted.length > 0 || lookupEntry.diff.$deleted.length > 0;
    }

    // This method builds a lookup where for every objectId the corresponding former and present object is stored for fast lookups later.
    private buildLookupTree(formerObject: any, presentObject: any): Map<any, IObjectLookupEntry> {
        // First we build a lookup tree for the former object.
        let result = this.buildFormerLookupTree(formerObject, this.globalLookup);
        if (result?.hasConflict) {
            const conflictingObjectRightPath = result.conflictingObjectRightPath.reverse();
            const conflictingObjectLeftPath: Array<string | number> = [];
            this.findPath(formerObject, result.conflictingObjectLeft, conflictingObjectLeftPath, new Set());
            conflictingObjectLeftPath.reverse();

            throw new ChangeCheckerObjectConflictError(
                `The former model contains two different objects with the same objectId (${result.objectId}). ` +
                `Did you mix partial snapshots containing the same object at different places? 1st Path: ${this.formatPath(conflictingObjectLeftPath)}, 2nd Path: ${this.formatPath(conflictingObjectRightPath)}`,
                result.source,
                result.objectId,
                conflictingObjectLeftPath,
                result.conflictingObjectLeft,
                conflictingObjectRightPath,
                result.conflictingObjectRight
            );
        }

        // Then we extend the lookup entries with the present object with the same objectId as the former object or create a new entry if there is no former object for a present object.
        result = this.buildPresentLookupTree(presentObject, this.globalLookup);
        if (result?.hasConflict) {
            const conflictingObjectRightPath = result.conflictingObjectRightPath.reverse();
            const conflictingObjectLeftPath: Array<string | number> = [];
            this.findPath(presentObject, result.conflictingObjectLeft, conflictingObjectLeftPath, new Set());
            conflictingObjectLeftPath.reverse();

            throw new ChangeCheckerObjectConflictError(
                `The present model contains two different objects with the same objectId (${result.objectId}). ` +
                `Did you mix partial snapshots containing the same object at different places? 1st Path: ${this.formatPath(conflictingObjectLeftPath)}, 2nd Path: ${this.formatPath(conflictingObjectRightPath)}`,
                result.source,
                result.objectId,
                conflictingObjectLeftPath,
                result.conflictingObjectLeft,
                conflictingObjectRightPath,
                result.conflictingObjectRight
            );
        }

        return this.globalLookup;
    }

    // Here we just decide if the object is an array, object or value like (e.g. Date's, RegExp's, or other objects that should be treated as values).
    private buildFormerLookupTree(former: any, globalLookup: Map<any, IObjectLookupEntry>): ILookupBuilderConflictResult | undefined {
        if (Array.isArray(former)) {
            return this.buildFormerArrayLookupTree(former, globalLookup);
        }

        if (this.isObject(former)) {
            if (this.isValueLike(former)) {
                return undefined;
            }

            return this.buildFormerObjectLookupTree(former, globalLookup);
        }

        return undefined;
    }

    private buildFormerArrayLookupTree(formerArray: any[], globalLookup: Map<any, IObjectLookupEntry>): ILookupBuilderConflictResult | undefined {
        // Get the object id of the array.
        const lookupKey = (formerArray as any)[objectIdSymbol];

        // If the lookup not yet contains the object id, we create a new entry.
        let lookupEntry: IObjectLookupEntry | undefined = globalLookup.get(lookupKey);
        if (lookupEntry === undefined) {
            lookupEntry = {
                formerObject: formerArray,
                presentObject: null,
                propertyKeys: new Set(),
                // We create the diff instances in advance so we don't need to care about in what order the objects are traversed later (because the diff object can be resolved at any time regardless of the object for the diff has been processed already).
                diff: new ArrayDiffImpl(this.isDirtyArrow, this.unwrapArrow)
            };

            globalLookup.set(lookupKey, lookupEntry);
        }
        else {
            // If the lookup already contains the object
            if (lookupEntry.formerObject) {
                // but the reference is not the same an error must have been happend by updating the former model with copies of another instance but with the same object id.
                if (lookupEntry.formerObject !== formerArray) {
                    return {
                        hasConflict: true,
                        source: "FormerModel",
                        objectId: lookupKey,
                        conflictingObjectLeft: lookupEntry.formerObject,
                        conflictingObjectRight: formerArray,
                        conflictingObjectRightPath: []
                    };
                }

                // if the object is already set, it must have already been processed and we can stop here (circular reference protection).
                return;
            }

            lookupEntry.formerObject = formerArray;
        }

        // Now we iterate over all items in the array and build the lookup tree for each item.
        for (let i = 0; i < formerArray.length; i++) {
            const result = this.buildFormerLookupTree(formerArray[i], globalLookup);
            if (result?.hasConflict) {
                result.conflictingObjectRightPath.push(i);
                return result;
            }
        }

        return undefined;
    }

    private buildFormerObjectLookupTree(formerObject: any, globalLookup: Map<any, IObjectLookupEntry>): ILookupBuilderConflictResult | undefined {
        // Get the object id of the object.
        const lookupKey = (formerObject as any)[objectIdSymbol];

        // If the lookup not yet contains the object id, we create a new entry.
        let lookupEntry: IObjectLookupEntry | undefined = globalLookup.get(lookupKey);
        if (lookupEntry === undefined) {
            // Here we resolve the property keys of the object and cache them to avoid work in the future if we need to iterate the object's properties again.
            const propertyKeys = this.getPropertyKeys(formerObject);

            lookupEntry = {
                formerObject,
                presentObject: null,
                propertyKeys,
                // We create the diff instances in advance so we don't need to care about in what order the objects are traversed later.
                diff: new ObjectDiffImpl(this.isDirtyArrow, this.unwrapArrow)
            };

            globalLookup.set(lookupKey, lookupEntry);

            for (const propertyKey of propertyKeys) {
                const property = formerObject[propertyKey];
                const result = this.buildFormerLookupTree(property, globalLookup);
                if (result?.hasConflict) {
                    result.conflictingObjectRightPath.push(propertyKey);
                    return result;
                }
            }
        }
        else {
            // If the lookup already contains the object
            if (lookupEntry.formerObject) {
                // but the reference is not the same an error must have been happend by updating the former model with copies of another instance but with the same object id.
                if (lookupEntry.formerObject !== formerObject) {
                    return {
                        hasConflict: true,
                        source: "FormerModel",
                        objectId: lookupKey,
                        conflictingObjectLeft: lookupEntry.formerObject,
                        conflictingObjectRight: formerObject,
                        conflictingObjectRightPath: []
                    };
                }

                // If the object is already set, it must have already been processed and we can stop here (circular reference protection).
                return;
            }

            lookupEntry.formerObject = formerObject;

            // Now we iterate over all properties of the object and build the lookup tree for each property.
            for (const propertyKey of this.getPropertyKeys(formerObject)) {
                lookupEntry.propertyKeys.add(propertyKey);
                const property = formerObject[propertyKey];
                const result = this.buildFormerLookupTree(property, globalLookup);
                if (result?.hasConflict) {
                    result.conflictingObjectRightPath.push(propertyKey);
                    return result;
                }
            }
        }

        return undefined;
    }

    // Here we just decide if the object is an array, object or value like (e.g. Date's, RegExp's, or other objects that should be treated as values).
    private buildPresentLookupTree(present: any, globalLookup: Map<any, IObjectLookupEntry>): ILookupBuilderConflictResult | undefined {
        if (Array.isArray(present)) {
            return this.buildPresentArrayLookupTree(present, globalLookup);
        }

        if (this.isObject(present)) {
            if (this.isValueLike(present)) {
                return;
            }

            return this.buildPresentObjectLookupTree(present, globalLookup);
        }

        return undefined;
    }

    private buildPresentArrayLookupTree(presentArray: any[], globalLookup: Map<any, IObjectLookupEntry>): ILookupBuilderConflictResult | undefined {
        // Not all arrays of the present model must have an objectId (newly created objects) so we can use the object itself as fallback key for the lookup.
        const lookupKey = (presentArray as any)[objectIdSymbol] || presentArray;

        let lookupEntry: IObjectLookupEntry | undefined = globalLookup.get(lookupKey);
        if (lookupEntry === undefined) {
            lookupEntry = {
                formerObject: null,
                presentObject: presentArray,
                propertyKeys: new Set(),
                // We create the diff instances in advance so we don't need to care about in what order the objects are traversed later.
                diff: new ArrayDiffImpl(this.isDirtyArrow, this.unwrapArrow)
            };

            globalLookup.set(lookupKey, lookupEntry);
        }
        else {
            if (lookupEntry.presentObject) {
                if (lookupEntry.presentObject !== presentArray) {
                    return {
                        hasConflict: true,
                        source: "PresentModel",
                        objectId: lookupKey,
                        conflictingObjectLeft: lookupEntry.presentObject,
                        conflictingObjectRight: presentArray,
                        conflictingObjectRightPath: []
                    };
                }

                // If the object is already set, it must have already been processed and we can stop here (circular reference protection).
                return;
            }

            lookupEntry.presentObject = presentArray;
        }

        for (let i = 0; i < presentArray.length; i++) {
            const result = this.buildPresentLookupTree(presentArray[i], globalLookup);
            if (result?.hasConflict) {
                result.conflictingObjectRightPath.push(i);
                return result;
            }
        }

        return undefined;
    }

    private buildPresentObjectLookupTree(presentObject: any, globalLookup: Map<any, IObjectLookupEntry>): ILookupBuilderConflictResult | undefined {
        // Not all objects of the present model must have an objectId (newly created objects) so we can use the object itself as fallback key for the lookup.
        const lookupKey = (presentObject as any)[objectIdSymbol] || presentObject;

        let lookupEntry: IObjectLookupEntry | undefined = globalLookup.get(lookupKey);
        if (lookupEntry === undefined) {
            const propertyKeys = this.getPropertyKeys(presentObject);

            lookupEntry = {
                formerObject: null,
                presentObject,
                propertyKeys,
                // We create the diff instances in advance so we don't need to care about in what order the objects are traversed later.
                diff: new ObjectDiffImpl(this.isDirtyArrow, this.unwrapArrow)
            };

            globalLookup.set(lookupKey, lookupEntry);

            for (const propertyKey of propertyKeys) {
                const property = presentObject[propertyKey];
                const result = this.buildPresentLookupTree(property, globalLookup);
                if (result?.hasConflict) {
                    result.conflictingObjectRightPath.push(propertyKey);
                    return result;
                }
            }
        }
        else {
            if (lookupEntry.presentObject) {
                if (lookupEntry.presentObject !== presentObject) {
                    return {
                        hasConflict: true,
                        source: "PresentModel",
                        objectId: lookupKey,
                        conflictingObjectLeft: lookupEntry.presentObject,
                        conflictingObjectRight: presentObject,
                        conflictingObjectRightPath: []
                    };
                }

                // If the object is already set, it must have already been processed and we can stop here (circular reference protection).
                return;
            }

            lookupEntry.presentObject = presentObject;

            for (const propertyKey of this.getPropertyKeys(presentObject)) {
                // Here we add the properties of the present object to the cached property keys of the lookup entry because the new object could have more properties than the former one.
                lookupEntry.propertyKeys.add(propertyKey);
                const property = presentObject[propertyKey];
                const result = this.buildPresentLookupTree(property, globalLookup);
                if (result?.hasConflict) {
                    result.conflictingObjectRightPath.push(propertyKey);
                    return result;
                }
            }
        }

        return undefined;
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

        for (const plugin of this.valueLikePlugins) {
            if (plugin.isMatch(any)) {
                return plugin.clone({ clone: (x) => this.clone(x, referenceMap) }, any);
            }
        }

        for (const plugin of this.referenceLikePlugins) {
            if (plugin.clone && plugin.isMatch(any)) {
                const clone = plugin.clone({ clone: (x) => this.clone(x, referenceMap) }, any);
                clone[objectIdSymbol] = any[objectIdSymbol];
                referenceMap.set(any, clone);
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

    private mergeSnapshotIntoModel(model: object, snapshot: object): void {
        const objectsByObjectId = this.collectObjectsWithObjectId(snapshot, new Map(), new Set());
        if (objectsByObjectId.size === 0) {
            return;
        }

        this.replaceObjectsWithSameObjectIdEverywhere(model, objectsByObjectId, new Set());
    }

    private collectObjectsWithObjectId(any: any, objectCollection: Map<string, object>, seenObjects: Set<any>): Map<string, object> {
        if (any == undefined) {
            return objectCollection;
        }

        if (this.isValueType(any)) {
            return objectCollection;
        }

        if (this.isValueLike(any)) {
            return objectCollection;
        }

        if (typeof any === "function") {
            return objectCollection;
        }

        if (seenObjects.has(any)) {
            return objectCollection;
        }

        seenObjects.add(any);

        if (this.isReference(any)) {
            objectCollection.set(any[objectIdSymbol], any);
        }

        if (Array.isArray(any)) {
            for (const entry of any) {
                this.collectObjectsWithObjectId(entry, objectCollection, seenObjects);
            }
        }
        else {
            for (const propertyKey of this.getPropertyKeys(any)) {
                const property = any[propertyKey];
                this.collectObjectsWithObjectId(property, objectCollection, seenObjects);
            }
        }

        return objectCollection;
    }

    private replaceObjectsWithSameObjectIdEverywhere(any: any, objectsByObjectId: Map<string, object>, seenObjects: Set<any>): void {
        if (any == undefined) {
            return;
        }

        if (this.isValueType(any)) {
            return;
        }

        if (this.isValueLike(any)) {
            return;
        }

        if (typeof any === "function") {
            return;
        }

        if (seenObjects.has(any)) {
            return;
        }

        seenObjects.add(any);

        if (Array.isArray(any)) {
            for (let i = 0; i < any.length; i++) {
                const entry = any[i];
                if (this.isReference(entry) && objectsByObjectId.has(entry[objectIdSymbol])) {
                    const newObject = objectsByObjectId.get(entry[objectIdSymbol]);

                    // If we replace the old object with the new one we don't need to traverse the tree further since the new object should always be up to date.
                    any[i] = newObject;
                }
                else {
                    this.replaceObjectsWithSameObjectIdEverywhere(any[i], objectsByObjectId, seenObjects);
                }
            }
        }
        else {
            for (const propertyKey of this.getPropertyKeys(any)) {
                const property = any[propertyKey];
                if (this.isReference(property) && objectsByObjectId.has(property[objectIdSymbol])) {
                    const newObject = objectsByObjectId.get(property[objectIdSymbol]);

                    // If we replace the old object with the new one we don't need to traverse the tree further since the new object should always be up to date.
                    any[propertyKey] = newObject;
                }
                else {
                    this.replaceObjectsWithSameObjectIdEverywhere(any[propertyKey], objectsByObjectId, seenObjects);
                }
            }
        }
    }

    private assignObjectIds(obj: any, seenObjects: Set<any>): void {
        if (seenObjects.has(obj)) {
            // We have already assigned an id to this object.
            return;
        }

        seenObjects.add(obj);

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
                        // We don't assign object ids to value like objects (Date's, RegExp's, etc).
                        continue;
                    }

                    this.assignObjectIds(item, seenObjects);
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
                        // We don't assign object ids to value like objects (Date's, RegExp's, etc).
                        continue;
                    }

                    this.assignObjectIds(value, seenObjects);
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

    // Given a value and the lookup this function either returns the value (string, number, boolean, null, undefined etc.), the value like (Date, RegExp, etc.)
    // or the diff if the value is an object with an objectId or the object itself is the key to find the diff (this is the case if the object exists only in the present model).
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
                // In this case we used the present object as lookup key (see: buildPresentObjectLookupTree).
                return entry.diff;
            }

            const plugin = this.valueLikePlugins.find((x) => x.isMatch(valueOrReference));
            if (plugin) {
                // Because some "value likes" (like Date) can be changed by methods (e.g. setDate) we need to copy here.
                return plugin.clone!({ clone: <T>(x: T) => this.clone(x, new Map()) }, valueOrReference);
            }
        }

        return valueOrReference;
    }

    // This function returns all property keys of an object and its prototype chain.
    // It is similar to Object.getOwnPropertyNames but also returns the property keys of the prototype chain and ignores system-defined properties (e.g. __proto__).
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

    // This function reconstructs the former object from a diff by traversing the diff tree and building new objects with the $formerValue properties or the $value properties if the value has not been changed.
    private unwrapFormerInternal(diff: any, referenceMap: Map<any, any>): any {
        if (referenceMap.has(diff)) {
            // We have already created the object so we reuse it to match the reference semantics of the original object.
            return referenceMap.get(diff);
        }

        if (isChangedProperty(diff)) {
            // The diff is a changed property diff (e.g. { $formerValue: 1, $value: 2 }).
            if (this.isValueType(diff.$formerValue) || this.isValueLike(diff.$formerValue)) {
                // If the $formerValue is a value type (string, number, boolean, null, undefined etc.) or a value like (Date, RegExp, etc.) we can return it directly.
                return diff.$formerValue;
            }

            // Else we need to unwrap the $formerValue further.
            return this.unwrapFormerInternal(diff.$formerValue, referenceMap);
        }

        if (isUnchangeProperty(diff)) {
            // The diff is an unchange property diff (e.g. { $value: 1 }).
            if (this.isValueType(diff.$value) || this.isValueLike(diff.$value)) {
                // If the $value is a value type (string, number, boolean, null, undefined etc.) or a value like (Date, RegExp, etc.) we can return it directly.
                return diff.$value;
            }

            // Else we need to unwrap the $value further.
            return this.unwrapFormerInternal(diff.$value, referenceMap);
        }

        if (isArrayDiff(diff)) {
            // If its an array diff we create a new array and add it to the reference map before we unwrap the array items because the array could contain itself and this would lead to an infinite loop.
            const formerArray: any = [];
            referenceMap.set(diff, formerArray);

            // Then we push the deleted items and the other items (that are the items that were present in the former and present model) to the array.
            formerArray.push(...diff.$other.map((x) => this.isValueType(x) || this.isValueLike(x) ? x : this.unwrapFormerInternal(x, referenceMap)));
            formerArray.push(...diff.$deleted.map((x) => this.isValueType(x) || this.isValueLike(x) ? x : this.unwrapFormerInternal(x, referenceMap)));

            // If the array has an objectId we assign it to the newly created array so that the resulting object is a fully functional change checker compatible object for further use.
            const objectId = (diff as any)[objectIdSymbol];
            if (objectId) {
                formerArray[objectIdSymbol] = objectId;
            }

            return formerArray;
        }

        if (isObjectDiff(diff)) {
            // If its an object diff we create a new object and add it to the reference map before we unwrap the object properties because the object could contain itself and this would lead to an infinite loop.
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

                // If the property has an objectId we assign it to the newly created object so that the resulting object is a fully functional change checker compatible object for further use.
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

    // This function reconstructs the present object from a diff by traversing the diff tree and building new objects with the $value properties.
    private unwrapPresentInternal(diff: any, referenceMap: Map<any, any>): any {
        if (referenceMap.has(diff)) {
            // We have already created the object so we reuse it to match the reference semantics of the original object.
            return referenceMap.get(diff);
        }

        if (isPropertyDiff(diff)) {
            // The diff is a property diff (e.g. { $value: 1 }).
            if (this.isValueType(diff.$value) || this.isValueLike(diff.$value)) {
                // If the $value is a value type (string, number, boolean, null, undefined etc.) or a value like (Date, RegExp, etc.) we can return it directly.
                return diff.$value;
            }

            // Else we need to unwrap the $value further.
            return this.unwrapPresentInternal(diff.$value, referenceMap);
        }

        if (isArrayDiff(diff)) {
            // If its an array diff we create a new array and add it to the reference map before we unwrap the array items because the array could contain itself and this would lead to an infinite loop.
            const presentArray: any = [];
            referenceMap.set(diff, presentArray);

            // Then we push the inserted items and the other items (that are the items that are present in the present and former model) to the array.
            presentArray.push(...diff.$other.map((x) => this.isValueType(x) || this.isValueLike(x) ? x : this.unwrapPresentInternal(x, referenceMap)));
            presentArray.push(...diff.$inserted.map((x) => this.isValueType(x) || this.isValueLike(x) ? x : this.unwrapPresentInternal(x, referenceMap)));

            // If the array has an objectId we assign it to the newly created array so that the resulting object is a fully functional change checker compatible object for further use.
            const objectId = (diff as any)[objectIdSymbol];
            if (objectId) {
                presentArray[objectIdSymbol] = objectId;
            }

            return presentArray;
        }

        if (isObjectDiff(diff)) {
            // If its an object diff we create a new object and add it to the reference map before we unwrap the object properties because the object could contain itself and this would lead to an infinite loop.
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

            // If the object has an objectId we assign it to the newly created object so that the resulting object is a fully functional change checker compatible object for further use.
            const objectId = (diff as any)[objectIdSymbol];
            if (objectId) {
                presentObject[objectIdSymbol] = objectId;
            }

            return presentObject;
        }

        return diff;
    }

    // This function checks if a diff is dirty by traversing the diff tree and checking if any of the inner diffs are $isChanged, $isCreated or $isDeleted.
    private isDirtyInternal(diff: any, seenObjects: Set<any>): boolean {
        if (seenObjects.has(diff)) {
            // We have already seen this object so we can return false because if we had seen the object before it would have been dirty then we would have returned true earlier.
            return false;
        }
        seenObjects.add(diff);

        if (isPropertyDiff(diff)) {
            if (diff.$isChanged) {
                // If the property has been changed by setting e.g. fooProp from 1 to 2 or from reference to object a to reference to object b we return true.
                return true;
            }

            if (this.isValueType(diff.$value) || this.isValueLike(diff.$value)) {
                // Value likes like Date, RegExp, etc. can not be dirty because they are immutable.
                return false;
            }

            if (this.isDirtyInternal(diff.$value, seenObjects)) {
                // If the object the property is pointing to is dirty we return true.
                return true;
            }
        }

        if (isObjectDiff(diff)) {
            if (diff.$isChanged || diff.$isCreated || diff.$isDeleted) {
                // If diff is an object diff and it is $isChanged, $isCreated or $isDeleted we return true.
                return true;
            }

            for (const key of this.getPropertyKeys(diff)) {
                // If any property is dirty or pointing to a dirty object we return true.
                const property = (diff as any)[key];
                if (this.isDirtyInternal(property, seenObjects)) {
                    return true;
                }
            }

            return false;
        }

        if (isArrayDiff(diff)) {
            if (diff.$isChanged || diff.$isCreated || diff.$isDeleted) {
                // If diff is an array diff and it is $isChanged, $isCreated or $isDeleted we
                return true;
            }

            for (const item of diff.$other) {
                if (this.isValueType(item) || this.isValueLike(item)) {
                    // If the item is a value type (string, number, boolean, null, undefined etc.) or a value like (Date, RegExp, etc.) we can skip it because it can not be dirty.
                    continue;
                }

                if (this.isObject(item) && this.isDirtyInternal(item, seenObjects)) {
                    // If the item is an object and it is dirty we return true.
                    return true;
                }
            }
        }

        return false;
    }

    // This is a helper function to determine if a value is an object because typeof null === "object" is true.
    private isObject(node: any): boolean {
        return typeof node === "object" && node !== null;
    }

    // This is a helper function to determine if a value is a value type like string, number, boolean, null or undefined.
    private isValueType(node: any): node is ValueType {
        return node == undefined ||
            typeof node === "string" ||
            typeof node === "number" ||
            typeof node === "boolean";
    }

    // This is a helper function to determine if a value is a value like Date, RegExp, etc.
    private isValueLike(node: any): node is ValueLike {
        return this.isObject(node) && this.valueLikePlugins.some((x) => x.isMatch(node));
    }

    // This is a helper function to determine if a value is a reference to an object with an objectId.
    private isReference(node: any): node is { [objectIdSymbol]: string; } {
        return this.isObject(node) && node[objectIdSymbol] !== undefined;
    }

    // This is a helper function to find a path to an object (e.g. model.property[123].a) to build a good error message.
    private findPath(haystack: any, needle: object, path: Array<string | number>, seenObjects: Set<any>): boolean {
        if (seenObjects.has(haystack)) {
            return false;
        }

        seenObjects.add(haystack);

        if (haystack === needle) {
            return true;
        }

        if (Array.isArray(haystack)) {
            for (let i = 0; i < haystack.length; i++) {
                if (this.findPath(haystack[i], needle, path, seenObjects)) {
                    path.push(i);
                    return true;
                }
            }
        }
        else if (this.isObject(haystack)) {
            if (this.isValueLike(haystack)) {
                return false;
            }

            for (const propertyKey of this.getPropertyKeys(haystack)) {
                if (this.findPath(haystack[propertyKey], needle, path, seenObjects)) {
                    path.push(propertyKey);
                    return true;
                }
            }
        }

        return false;
    }

    // This is a helper function to format a path to a string (e.g. model.property[123].a).
    private formatPath(path: Array<string | number>): string {
        let result = "";
        for (let i = 0; i < path.length; i++) {
            const part = path[i];

            if (typeof part === "number") {
                result += "[" + part + "]";
                continue;
            }

            if (i === 0) {
                result += part;
            }
            else {
                result += "." + part;
            }
        }

        return result;
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

// We use class instances for all diff types to get better performance because instanceof is faster than building objects inline.
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

// We use symbols for all internal properties to avoid name collisions with user properties and faster access.
const $isCreatedSymbol: unique symbol = Symbol.for("internalIsCreatedSymbol");
const $isDeletedSymbol: unique symbol = Symbol.for("internalIsDeletedSymbol");
const $isChangedSymbol: unique symbol = Symbol.for("internalIsChangedSymbol");
const $isDirtySymbol: unique symbol = Symbol.for("internalIsDirtySymbol");
const $unwrapSymbol: unique symbol = Symbol.for("internalUnwrapSymbol");

class ObjectDiffImpl implements Iterable<{ propertyName: string; propertyDiff: PropertyDiffImpl }> {
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

    // This makes it possible to iterate object diffs with a for-of loop etc.
    public [Symbol.iterator](): Iterator<{ propertyName: string; propertyDiff: PropertyDiffImpl; }> {
        let index = -1;
        const propertyDiffs = Object.entries(this).filter((x) => isPropertyDiff(x[1])).map((x) => ({ propertyName: x[0], propertyDiff: x[1] }));

        return {
            next: () => {
                const entry = propertyDiffs[++index];
                return {
                    value: entry,
                    done: !(index in propertyDiffs)
                };
            }
        };
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

    public get $all(): any[] {
        return [...this.$inserted, ...this.$deleted, ...this.$other];
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

interface ILookupBuilderConflictResult {
    hasConflict: true;
    source: "FormerModel" | "PresentModel";
    objectId: string;
    conflictingObjectLeft: object;
    conflictingObjectRightPath: Array<string | number>;
    conflictingObjectRight: object;
}

interface ISnapshotMerger<T> {
    target: T;
}
