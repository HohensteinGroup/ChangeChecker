import { IValueLikeRegistry } from "./ValueLikeRegistry";

export interface IUnchangedProperty<T> {
    readonly $value: T extends ValueTypeOrValueLike ? T
    : T extends Array<infer U> ? IArrayDiff<U>
    : T extends object ? ObjectDiff<T>
    : never;
    readonly $isChanged: false;
    $isDirty(): boolean;
    $unwrap(era: Era): T;
}

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

export type ArrayDiffEntry<T> = T extends ValueTypeOrValueLike ? T
    : T extends Array<infer U> ? IArrayDiff<U>
    : T extends object ? ObjectDiff<T>
    : never;

export type ObjectDiff<T> = {
    readonly $state: State;
    readonly $isCreated: boolean;
    readonly $isDeleted: boolean;
    readonly $isChanged: boolean;
    $isDirty(): boolean;
    $unwrap(era: Era): T;
    [Symbol.iterator](): Iterator<{ propertyName: string; propertyDiff: PropertyDiff<Exclude<T[keyof T], Function>> }>;
} & PropertiesDiffed<T>;

export type PropertiesDiffed<T> = {
    readonly [K in keyof Pick<T, PropertyKeysOf<T>>]: PropertyDiff<T[K]>;
};

export type PropertyDiff<T> = IUnchangedProperty<T> | IChangedProperty<T>;

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
export type ValueLike = IValueLikeRegistry[keyof IValueLikeRegistry];
