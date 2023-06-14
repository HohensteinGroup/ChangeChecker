import { IValueLikeRegistry } from "./ValueLikeRegistry";

// This type is used to create a type for an unchanged property of an object type T.
// It will either
//  - be the value type or value like type if T is a value type or value like type.
//  - be an array diff type if T is an array type.
//  - be an object diff type if T is an object type.
// For example:
// interface IMyObject {
//     a: Array<string | MyObject>;
// }
//
// IUnchangedProperty<IMyObject["a"]> =>
// {
//    $value: Array<string | MyObject>;
//    $isChanged: false;
//    $isDirty(): boolean;
//    $unwrap(era: Era): Array<string | MyObject>;
// }
export interface IUnchangedProperty<T> {
    readonly $value: T extends ValueTypeOrValueLike ? T
    : T extends Array<infer U> ? IArrayDiff<U>
    : T extends object ? ObjectDiff<T>
    : never;
    readonly $isChanged: false;
    $isDirty(): boolean;
    $unwrap(era: Era): T;
}

// This type is used to create a type for a changed property of an object type T.
// It will either
//  - be the value type or value like type if T is a value type or value like type.
//  - be an array diff type if T is an array type.
//  - be an object diff type if T is an object type.
// For example:
// interface IMyObject {
//     a: Array<string | MyObject>;
// }
// IChangedProperty<IMyObject["a"]> =>
// {
//     $formerValue: Array<string | MyObject>;
//     $value: Array<string | MyObject>;
//     $isChanged: true;
//     $isDirty(): boolean;
//     $unwrap(era: Era): Array<string | MyObject>;
// }
export interface IChangedProperty<T> {
    readonly $formerValue: T extends ValueTypeOrValueLike ? T
    : T extends Array<infer U> ? IArrayDiff<U>
    : T extends object ? ObjectDiff<T>
    : never;
    readonly $value: T extends ValueTypeOrValueLike ? T
    : T extends Array<infer U> ? IArrayDiff<U>
    : T extends object ? ObjectDiff<T>
    : never;
    readonly $isChanged: true;
    $isDirty(): boolean;
    $unwrap(era: Era): T;
}

// This type is used to create a type for an array where all items are either value types or value like types, array diff types or object diff types (see ArrayDiffEntry).
export interface IArrayDiff<T> {
    readonly $inserted: Array<ArrayDiffEntry<T>>;
    readonly $deleted: Array<ArrayDiffEntry<T>>;
    readonly $other: Array<ArrayDiffEntry<T>>;
    readonly $all: Array<ArrayDiffEntry<T>>;
    readonly $state: State;
    readonly $isCreated: boolean;
    readonly $isDeleted: boolean;
    readonly $isChanged: boolean;
    $isDirty(): boolean;
    $unwrap(era: Era): T[];
}

// This type is applied to all items of an array type T.
// It will either
//  - be the value type or value like type if T is a value type or value like type.
//  - be an array diff type if T is an array type.
//  - be an object diff type if T is an object type.
// For example:
// ArrayDiffEntry<string> => string
// ArrayDiffEntry<Date> => Date
// ArrayDiffEntry<Array<string>> => IArrayDiff<string>
// ArrayDiffEntry<Array<Date>> => IArrayDiff<Date>
// ArrayDiffEntry<{ a: string; b: number; c: boolean; }> => ObjectDiff<{ a: string; b: number; c: boolean; }>
export type ArrayDiffEntry<T> = T extends ValueTypeOrValueLike ? T
    : T extends Array<infer U> ? IArrayDiff<U>
    : T extends object ? ObjectDiff<T>
    : never;

// This type is used to create a type with all properties of an object type T but with all properties changed to their diff type.
// Additionally it contains some properties that are used to determine the state of the object.
// For example:
// interface IMyObject {
//    a: string;
//    b: number;
//    c: boolean;
// }
// ObjectDiff<IMyObject> =>
// {
//    $state: State;
//    $isCreated: boolean;
//    $isDeleted: boolean;
//    $isChanged: boolean;
//    $isDirty(): boolean;
//    $unwrap(era: Era): IMyObject;
//    [Symbol.iterator](): Iterator<{ propertyName: string; propertyDiff: PropertyDiff<Exclude<IMyObject[keyof IMyObject], Function>> }>;
//    a: PropertyDiff<string>;
//    b: PropertyDiff<number>;
//    c: PropertyDiff<boolean>;
// }

export type ObjectDiff<T> = {
    readonly $state: State;
    readonly $isCreated: boolean;
    readonly $isDeleted: boolean;
    readonly $isChanged: boolean;
    $isDirty(): boolean;
    $unwrap(era: Era): T;
    [Symbol.iterator](): Iterator<{ propertyName: string; propertyDiff: PropertyDiff<Exclude<T[keyof T], Function>> }>;
} & PropertiesDiffed<T>;

// This type is used to create a type with all properties of an object type T but with all properties changed to their diff type.
// For example:
// interface IMyObject {
//    a: string;
//    b: number;
//    c: boolean;
// }
// PropertiesDiffed<IMyObject> =>
// {
//    a: PropertyDiff<string>;
//    b: PropertyDiff<number>;
//    c: PropertyDiff<boolean>;
// }

export type PropertiesDiffed<T> = {
    readonly [K in keyof Pick<T, PropertyKeysOf<T>>]: PropertyDiff<T[K]>;
};

export type PropertyDiff<T> = IUnchangedProperty<T> | IChangedProperty<T>;

// This type is used to get all property keys of an object type T.
// For example:
// interface IMyObject {
//    a: string;
//    b: number;
//    c: boolean;
// }
// PropertyKeysOf<IMyObject> => "a" | "b" | "c"

// tslint:disable-next-line:ban-types
export type PropertyKeysOf<T> = ({ [P in keyof T]: T[P] extends Function ? never : P })[keyof T];

export enum State {
    Unchanged,
    Created,
    Changed,
    Deleted
}

export enum Era {
    Present,
    Former
}

export type ValueTypeOrValueLike = ValueLike | ValueType;
export type ValueType = string | number | boolean | null | undefined;

// Resolve all value like types from the registry.
export type ValueLike = IValueLikeRegistry[keyof IValueLikeRegistry];
