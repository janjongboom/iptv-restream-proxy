const UNSAFE_PROPERTY_TO_SAFE_ACCESSOR = {
    innerHTML: "safeInnerHTML",
    outerHTML: "safeOuterHTML",
};

function getPropertyName(node) {
    if (!node) {
        return null;
    }

    if (node.type === "Identifier") {
        return node.name;
    }

    if (node.type === "Literal" && typeof node.value === "string") {
        return node.value;
    }

    return null;
}

function isObjectDefinePropertyCall(node) {
    return (
        node?.type === "CallExpression" &&
        node.callee.type === "MemberExpression" &&
        !node.callee.computed &&
        node.callee.object.type === "Identifier" &&
        node.callee.object.name === "Object" &&
        node.callee.property.type === "Identifier" &&
        node.callee.property.name === "defineProperty"
    );
}

function isAllowedSafeAccessorImplementation(node, unsafePropertyName) {
    if (node.object.type !== "ThisExpression") {
        return false;
    }

    let currentNode = node.parent;
    let setterProperty = null;

    while (currentNode) {
        if (
            currentNode.type === "Property" &&
            currentNode.key.type === "Identifier" &&
            currentNode.key.name === "set"
        ) {
            setterProperty = currentNode;
            break;
        }

        currentNode = currentNode.parent;
    }

    if (!setterProperty) {
        return false;
    }

    const descriptorObject = setterProperty.parent;
    if (descriptorObject?.type !== "ObjectExpression") {
        return false;
    }

    const definePropertyCall = descriptorObject.parent;
    if (!isObjectDefinePropertyCall(definePropertyCall)) {
        return false;
    }

    const accessorNameArgument = definePropertyCall.arguments[1];
    if (accessorNameArgument?.type !== "Literal" || typeof accessorNameArgument.value !== "string") {
        return false;
    }

    return accessorNameArgument.value === UNSAFE_PROPERTY_TO_SAFE_ACCESSOR[unsafePropertyName];
}

export default {
    meta: {
        type: "problem",
        docs: {
            description: "Disallow direct innerHTML/outerHTML access in favor of safe accessors.",
        },
        schema: [],
        messages: {
            unsafeHtmlProperty:
                "Do not use direct {{propertyName}} access. Use {{safeAccessorName}} with an HtmlSafeString instead.",
        },
    },
    create(context) {
        return {
            MemberExpression(node) {
                if (node.computed) {
                    return;
                }

                const propertyName = getPropertyName(node.property);
                if (!propertyName || !Object.hasOwn(UNSAFE_PROPERTY_TO_SAFE_ACCESSOR, propertyName)) {
                    return;
                }

                if (isAllowedSafeAccessorImplementation(node, propertyName)) {
                    return;
                }

                context.report({
                    node: node.property,
                    messageId: "unsafeHtmlProperty",
                    data: {
                        propertyName,
                        safeAccessorName: UNSAFE_PROPERTY_TO_SAFE_ACCESSOR[propertyName],
                    },
                });
            },
        };
    },
};
